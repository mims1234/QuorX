// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Model sources: where a chat's main model runs. OpenRouter is the default and stays behind everything else QuorX
// does (deciders, media, helpers, the reviewer, every fallback). OpenCode (pay as you go, and its Go plan) and Cline can run the main model
// on the user's own account with them.
//   - A source model's id is the source, a slash, and the model as that source names it: opencode/big-pickle,
//     opencode-go/glm-5.3, cline/anthropic/claude-sonnet-5.5. OpenRouter has no vendor by those names, and no id of
//     its own has two slashes, so the id alone says where a call goes and every picker, chat and schedule just works.
//   - Keys live in data/sources.json on this computer: the page sees them masked, agent processes never get them.
//   - OpenCode's model list (addresses, wire formats, prices, limits) comes from models.dev, the catalogue OpenCode
//     itself reads, so a model or address that moves there moves here too. Cline's comes from Cline.
//   - When a source fails or answers in a shape QuorX can't read, the agent falls back to OpenRouter for that step and
//     says so (agent.js). What failed is kept here, so other chats skip a source that is down instead of waiting on it.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { HOME, ROOT } from './openrouter.js';
import { BUILD, READ, readWhole, errorText } from './wire.js';
import { renameSoon } from './fsretry.js';
import { findOnPath, localModels, localStream, ensureLocalServer, localServer, LOCAL_ID } from './opencodelocal.js';

const DATA = path.join(HOME, 'data');
export const SOURCE_FILE = path.join(DATA, 'sources.json');
const CATALOGUE_COPY = path.join(DATA, 'source-models.json'); // the last good lists, for when the network is down

// What QuorX knows about each source. `api` is used when the catalogue gives no address for a model; `models` lists
// the ids the source serves today (a model the catalogue still has but the source dropped is left out).
// Their free models are listed too. Today OpenCode keeps its free models for OpenCode itself (another app gets "Free
// usage limit reached") and Cline keeps its own for its apps: QuorX asks honestly, under its own name, and a refusal sets
// only that model aside (failureKind 'free'). QuorX never borrows either app's sign-in or poses as it.
export const SOURCES = {
  // The OpenCode app on this computer (opencodelocal.js): every provider connected there, with no key in QuorX.
  [LOCAL_ID]: {
    id: LOCAL_ID, name: 'OpenCode on this PC', short: 'This PC', app: 'opencode', billing: 'mixed', local: true, api: {},
    site: 'https://opencode.ai', keyUrl: 'https://opencode.ai/docs/providers/', docs: 'https://opencode.ai/docs/server/',
    keyHint: 'No key: QuorX uses the providers you connected in OpenCode (opencode auth login).',
  },
  opencode: {
    id: 'opencode', name: 'OpenCode', short: 'OpenCode', app: 'opencode', billing: 'credits', session: true,
    md: 'opencode', api: { chat: 'https://opencode.ai/inference/openai/v1', responses: 'https://opencode.ai/inference/openai/v1', anthropic: 'https://opencode.ai/inference/anthropic/v1', google: 'https://opencode.ai/inference/google/v1beta' },
    models: 'https://opencode.ai/inference/v1/models',
    site: 'https://opencode.ai/console', keyUrl: 'https://opencode.ai/console', docs: 'https://opencode.ai/docs/',
    keyHint: 'An OpenCode Console API key (Account → Personal API keys; it starts with oc_sk_).',
  },
  'opencode-go': {
    id: 'opencode-go', name: 'OpenCode Go', short: 'Go', app: 'opencode', billing: 'plan', session: true,
    md: 'opencode-go', api: { chat: 'https://opencode.ai/inference/go/openai/v1', responses: 'https://opencode.ai/inference/go/openai/v1', anthropic: 'https://opencode.ai/inference/go/anthropic/v1', google: 'https://opencode.ai/inference/go/google/v1beta' },
    models: 'https://opencode.ai/inference/go/v1/models',
    site: 'https://opencode.ai/go', keyUrl: 'https://opencode.ai/console', docs: 'https://opencode.ai/docs/go/',
    keyHint: 'An OpenCode Console API key from the workspace that has the Go subscription.',
  },
  cline: {
    id: 'cline', name: 'Cline', short: 'Cline', app: 'cline', billing: 'credits', openrouterLike: true,
    api: { chat: 'https://api.cline.bot/api/v1' }, models: 'https://api.cline.bot/api/v1/ai/cline/models', recommended: 'https://api.cline.bot/api/v1/ai/cline/recommended-models', me: 'https://api.cline.bot/api/v1/users/me',
    site: 'https://app.cline.bot', keyUrl: 'https://app.cline.bot', docs: 'https://docs.cline.bot/api/getting-started',
    keyHint: 'A Cline API key (app.cline.bot → Settings → API Keys).',
  },
};
export const SOURCE_IDS = Object.keys(SOURCES);
const MODELS_DEV = process.env.QX_MODELS_DEV || 'https://models.dev/api.json';

/** { source, model, def } for a source model id, or null for an OpenRouter one. */
export function sourceOf(id) {
  const s = String(id || '');
  const i = s.indexOf('/');
  if (i <= 0) return null;
  const head = s.slice(0, i), model = s.slice(i + 1);
  return Object.hasOwn(SOURCES, head) && model ? { source: head, model, def: SOURCES[head] } : null;
}
export const isSourceModel = (id) => !!sourceOf(id);
const known = (id) => { if (!Object.hasOwn(SOURCES, String(id))) throw new Error('no such source'); };

// ---------- keys (data/sources.json) ----------
function load() { try { return JSON.parse(fs.readFileSync(SOURCE_FILE, 'utf8')) || {}; } catch { return {}; } }
function save(s) {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(SOURCE_FILE + '.tmp', JSON.stringify(s, null, 2));
  renameSoon(SOURCE_FILE + '.tmp', SOURCE_FILE);
}
const mask = (k) => (k.length > 16 ? `${k.slice(0, 6)}••••••••${k.slice(-4)}` : '••••••••');
const hash = (k) => crypto.createHash('sha256').update(String(k || '')).digest('hex').slice(0, 12);
// The key a call uses: the one saved here, else the source's environment variable.
const ENV = { opencode: 'OPENCODE_API_KEY', 'opencode-go': 'OPENCODE_API_KEY', cline: 'CLINE_API_KEY' };
export function keyFor(id) {
  const s = load()[id];
  if (s?.key) return { key: s.key, from: s.from || 'pasted' };
  if (process.env[ENV[id]]) return { key: process.env[ENV[id]], from: 'env' };
  return null;
}
/** Whether a source's models show in the pickers: switched on, with a way in. */
export const sourceOn = (id) => !!load()[id]?.on && (SOURCES[id]?.local ? !!findOnPath('opencode') : !!keyFor(id));

export function setSourceKey(id, key, from = 'pasted') {
  known(id);
  key = String(key || '').trim();
  if (key.length < 8 || /\s/.test(key)) throw new Error(`That does not look like a key. ${SOURCES[id].keyHint}`);
  if (/^sk-or-/.test(key)) throw new Error('That is an OpenRouter key: add it in ⚙ Settings → API keys instead.');
  const s = load();
  s[id] = { ...(s[id] || {}), key, from, added: Date.now(), on: true };
  // OpenCode's one key serves pay as you go and Go: saving it for one offers it to the other, without switching that one on.
  if (SOURCES[id].app === 'opencode') for (const o of SOURCE_IDS) if (o !== id && SOURCES[o].app === 'opencode' && !SOURCES[o].local && !s[o]?.key) s[o] = { ...(s[o] || {}), key, from, added: Date.now(), on: !!s[o]?.on };
  save(s);
  clearHealth(id);
  dropCatalogue();
}
// Removing a key switches the source off, and takes the same key from the other OpenCode source it was offered to.
export function removeSourceKey(id) {
  known(id);
  const s = load(), gone = s[id]?.key;
  for (const o of SOURCE_IDS) {
    if (o !== id && !(gone && SOURCES[o].app === SOURCES[id].app && s[o]?.key === gone)) continue;
    if (s[o]) { delete s[o].key; delete s[o].from; s[o].on = false; }
    clearHealth(o);
  }
  save(s);
  dropCatalogue();
}
export function setSourceOn(id, on) {
  known(id);
  const s = load(), next = { ...(s[id] || {}), on: !!on };
  if (on && SOURCES[id].local && !findOnPath('opencode')) throw new Error('OpenCode is not installed on this computer (npm i -g opencode-ai).');
  if (on && !SOURCES[id].local && !next.key && !process.env[ENV[id]]) throw new Error(`Add a key for ${SOURCES[id].name} first.`);
  s[id] = next;
  save(s);
  clearHealth(id);
  dropCatalogue();
}

// ---------- the apps on this computer ----------
// Where OpenCode keeps its keys and its copy of models.dev (XDG folders, under the user's profile on Windows too).
const home = () => process.env.QX_SOURCES_HOME || os.homedir();
const XDG_DEFAULT = { XDG_DATA_HOME: ['.local', 'share'], XDG_CACHE_HOME: ['.cache'] };
const xdg = (envName, ...rest) => path.join(process.env[envName] || path.join(home(), ...XDG_DEFAULT[envName]), ...rest);
export const OPENCODE_AUTH = () => xdg('XDG_DATA_HOME', 'opencode', 'auth.json');
const OPENCODE_MODELS = () => xdg('XDG_CACHE_HOME', 'opencode', 'models.json');
const CLINE_PROVIDERS = () => path.join(home(), '.cline', 'data', 'settings', 'providers.json');

// Which OpenCode providers have an API key in OpenCode (names only: the keys are read only when the user asks to use one).
function openCodeHas() {
  try {
    const j = JSON.parse(fs.readFileSync(OPENCODE_AUTH(), 'utf8'));
    return Object.entries(j || {}).filter(([k, v]) => (k === 'opencode' || k === 'opencode-go') && v?.type === 'api' && typeof v.key === 'string' && v.key.length > 8).map(([k]) => k);
  } catch { return []; }
}
/** The user clicked "Use the key OpenCode has": copy it from OpenCode's auth.json into QuorX. */
export function importOpenCodeKey(id) {
  if (SOURCES[id]?.app !== 'opencode') throw new Error('Only OpenCode keys can be taken from OpenCode.');
  let j;
  try { j = JSON.parse(fs.readFileSync(OPENCODE_AUTH(), 'utf8')); } catch { throw new Error('OpenCode has no saved keys on this computer (run "opencode auth login" first).'); }
  const pick = [id, ...SOURCE_IDS.filter((o) => SOURCES[o].app === 'opencode' && o !== id)].map((k) => j?.[k]).find((v) => v?.type === 'api' && typeof v.key === 'string' && v.key.length > 8);
  if (!pick) throw new Error('OpenCode on this computer has no API key for OpenCode or OpenCode Go (a sign-in of another kind can\'t be used here).');
  setSourceKey(id, pick.key, 'opencode');
}
// Whether the Cline CLI is signed in to a Cline account (not its token: QuorX never uses or refreshes it).
function clineSignedIn() {
  try {
    const j = JSON.parse(fs.readFileSync(CLINE_PROVIDERS(), 'utf8'));
    const c = j?.providers?.cline?.settings;
    return c?.auth ? { at: Date.parse(j.providers.cline.updatedAt || '') || null, model: c.model || null } : null;
  } catch { return null; }
}
// "opencode --version" and "cline --version", found on PATH (cached ten minutes).
const apps = new Map();
export function appVersion(name, { refresh = false, run = execFile } = {}) {
  const c = apps.get(name);
  if (c && !refresh && Date.now() - c.at < 10 * 60e3) return Promise.resolve(c.v);
  return new Promise((resolve) => {
    const f = findOnPath(name);
    if (!f) { apps.set(name, { v: null, at: Date.now() }); return resolve(null); }
    // A .cmd runs through cmd.exe; /s strips the outer pair of quotes, so the quoted path keeps its own.
    const cmd = /\.(cmd|bat)$/i.test(f) ? [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${f}" --version"`]] : [f, ['--version']];
    run(cmd[0], cmd[1], { timeout: 15000, windowsHide: true, windowsVerbatimArguments: /\.(cmd|bat)$/i.test(f) }, (err, out) => {
      const v = err ? null : (String(out).match(/\d+\.\d+\.\d+[\w.-]*/) || [null])[0];
      const res = { path: f, version: v };
      apps.set(name, { v: res, at: Date.now() });
      resolve(res);
    });
  });
}

// ---------- model lists ----------
let catalogue = null; // { at, list, error }
const dropCatalogue = () => { catalogue = null; };
// models.dev is edited by the community: a key goes only to the source's own site, whatever address it names.
const safeApi = (src, api) => { try { const u = new URL(String(api || '')); return u.protocol === 'https:' && u.origin === new URL(SOURCES[src].api.chat).origin ? u.href.replace(/\/+$/, '') : null; } catch { return null; } };
const FORMAT_OF = { '@ai-sdk/openai-compatible': 'chat', '@ai-sdk/openai': 'responses', '@ai-sdk/anthropic': 'anthropic', '@ai-sdk/google': 'google', '@ai-sdk/mistral': 'chat' };
const per = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
/** One models.dev model as a catalogue entry like OpenRouter's (openrouter.js slim), plus what a call needs. */
export function fromModelsDev(src, prov, m) {
  const npm = m.provider?.npm || prov.npm;
  const format = FORMAT_OF[npm] || 'chat';
  const cost = m.cost || {};
  const plan = SOURCES[src].billing === 'plan', free = isFreeModel(src, m);
  const list = [per(cost.input), per(cost.output)];
  const inl = m.interleaved && typeof m.interleaved === 'object' ? m.interleaved.field || null : m.interleaved === true ? true : null;
  return {
    id: `${src}/${m.id}`, realId: m.id, source: src, name: m.name || m.id, kind: 'chat', ctx: m.limit?.context || null, maxOut: m.limit?.output || null,
    created: m.release_date ? Math.floor(Date.parse(m.release_date) / 1000) || 0 : 0,
    in: (m.modalities?.input || ['text']).filter((x) => x === 'text' || x === 'image'), out: m.modalities?.output || ['text'],
    price: plan || free ? [0, 0] : list, listPrice: list, cost, plan: free ? 'free' : plan ? 'plan' : 'paid', ...(free ? { free: true } : {}),
    tools: m.tool_call !== false, temp: m.temperature !== false, reasoning: !!m.reasoning, reasoningOptions: Array.isArray(m.reasoning_options) ? m.reasoning_options : [],
    interleaved: inl, format, api: safeApi(src, m.provider?.api) || safeApi(src, prov.api) || SOURCES[src].api[format] || SOURCES[src].api.chat, status: m.status || null,
    canonical: m.canonical_model_id || null, desc: String(m.description || '').replace(/\s+/g, ' ').slice(0, 220),
  };
}
// A free model. OpenCode and Cline keep most of theirs for their own apps today: QuorX lists them and asks honestly,
// and when the source says no (failureKind 'free') only that model is set aside and the step goes to OpenRouter.
// If a source opens its free models to other apps, they simply work.
export const isFreeModel = (src, m) => (src === 'cline' ? /(^cline-free\/|-free$|:free$)/.test(m.id) : /-free$/.test(m.id) || (per(m.cost?.input) === 0 && per(m.cost?.output) === 0));
// One model from Cline's list (OpenRouter's catalogue format; ClinePass models are paid for by the plan).
export function fromCline(m) {
  const p = m.pricing || {};
  const inP = per(p.prompt) * 1e6, outP = per(p.completion) * 1e6, cached = p.input_cache_read != null ? per(p.input_cache_read) * 1e6 : null;
  const sp = m.supported_parameters || [];
  const plan = /^cline-pass\//.test(m.id), free = isFreeModel('cline', m) || m.free === true;
  return {
    id: `cline/${m.id}`, realId: m.id, source: 'cline', name: m.name || m.id, kind: 'chat', ctx: m.context_length || m.top_provider?.context_length || null, maxOut: m.top_provider?.max_completion_tokens || null,
    created: m.created || 0, in: (m.architecture?.input_modalities || ['text']).filter((x) => x === 'text' || x === 'image'), out: m.architecture?.output_modalities || ['text'],
    price: plan || free ? [0, 0] : [inP, outP], listPrice: [inP, outP], cost: { input: inP, output: outP, ...(cached != null ? { cache_read: cached } : {}) }, plan: free ? 'free' : plan ? 'plan' : 'paid', ...(free ? { free: true } : {}),
    tools: sp.length ? sp.includes('tools') : true, temp: sp.length ? sp.includes('temperature') : true, reasoning: sp.some((x) => x === 'reasoning' || x === 'include_reasoning'), reasoningOptions: [],
    interleaved: null, format: 'chat', api: SOURCES.cline.api.chat, status: m.expiration_date ? 'deprecated' : null, canonical: m.canonical_slug || m.id, desc: String(m.description || '').replace(/\s+/g, ' ').slice(0, 220),
  };
}
async function getJSON(url, headers = {}, ms = 20000) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`${new URL(url).host} said HTTP ${r.status}`);
  return r.json();
}
// models.dev, else OpenCode's own copy of it on this computer.
async function modelsDev() {
  try { return await getJSON(MODELS_DEV); }
  catch (e) { try { return JSON.parse(fs.readFileSync(OPENCODE_MODELS(), 'utf8')); } catch { throw e; } }
}
/**
 * The models of every source that is switched on (cached an hour; the last good list stays when a refresh fails).
 * `all`: every source's models whether it is on or not (Settings shows how many each has).
 */
export async function sourceModels({ refresh = false, all = false, fetchJSON = getJSON, dev = modelsDev } = {}) {
  const want = SOURCE_IDS.filter((id) => all || sourceOn(id));
  if (!want.length) return [];
  // A list that failed is tried again after a minute; a good one lasts an hour.
  const stale = !catalogue || Date.now() - catalogue.at > (Object.keys(catalogue.errors || {}).length ? 60e3 : 3600e3);
  if (refresh || stale || want.some((id) => !catalogue.ids.includes(id))) {
    const per = {}, errors = {};
    const ids = [...new Set([...(catalogue?.ids || []), ...want])];
    // Each source's list is built on its own, and a model entry QuorX can't read skips that model only.
    const each = (src, items, make, keep) => { const out = []; for (const m of items) { try { if (keep(m)) out.push(make(m)); } catch { /* one odd entry */ } } return out; };
    if (ids.some((id) => SOURCES[id].md)) {
      let j = null;
      try { j = await dev(); } catch (e) { for (const id of ids.filter((x) => SOURCES[x].md)) errors[id] = e.message; }
      for (const id of j ? ids.filter((x) => SOURCES[x].md) : []) {
        const prov = j?.[SOURCES[id].md];
        if (!prov?.models || typeof prov.models !== 'object') { errors[id] = 'not in the catalogue'; continue; }
        // The ids the gateway serves today (no key needed): a model it dropped is left out. When the list doesn't
        // load, the catalogue's own list stands.
        const live = await fetchJSON(SOURCES[id].models, {}, 10000).then((x) => new Set((Array.isArray(x?.data) ? x.data : []).map((m) => m?.id).filter(Boolean))).catch(() => null);
        per[id] = each(id, Object.values(prov.models), (m) => fromModelsDev(id, prov, m), (m) => m?.id && m.tool_call !== false && (Array.isArray(m.modalities?.output) ? m.modalities.output : ['text']).includes('text') && !(live?.size >= 5 && !live.has(m.id)));
      }
    }
    // The OpenCode on this computer: its server lists every model of every provider connected there.
    // Only once it is switched on: listing them starts OpenCode, which Settings alone never should.
    if (ids.includes(LOCAL_ID) && sourceOn(LOCAL_ID)) { try { per[LOCAL_ID] = await localModels(); } catch (e) { errors[LOCAL_ID] = e.message; } }
    if (ids.includes('cline')) {
      try {
        const j = await fetchJSON(SOURCES.cline.models, { Accept: 'application/json' });
        const data = Array.isArray(j?.data) ? j.data : Array.isArray(j) ? j : [];
        if (!data.length) throw new Error('Cline sent an empty model list');
        per.cline = each('cline', data, fromCline, (m) => m?.id && !/:batch$/.test(m.id) && (Array.isArray(m.architecture?.output_modalities) ? m.architecture.output_modalities : ['text']).includes('text'));
        // Cline's free models are not in that list: its recommended list names them.
        const rec = await fetchJSON(SOURCES.cline.recommended, { Accept: 'application/json' }, 10000).catch(() => null);
        const have = new Set(per.cline.map((m) => m.realId));
        for (const m of Array.isArray(rec?.free) ? rec.free : []) {
          if (!m?.id) continue;
          if (have.has(m.id)) { const x = per.cline.find((y) => y.realId === m.id); if (x && x.name === x.realId && m.name && m.name !== m.id) x.name = m.name; continue; }
          try { per.cline.push(fromCline({ id: m.id, name: m.name && m.name !== m.id ? m.name : m.id, description: m.description, free: true, pricing: { prompt: '0', completion: '0' } })); } catch { /* one odd entry */ }
        }
      } catch (e) { errors.cline = e.message; }
    }
    // A list that failed keeps its last good copy (in memory, else on disk); each good list is saved for next time.
    let old = catalogue?.list || [];
    if (!old.length) { try { old = JSON.parse(fs.readFileSync(CATALOGUE_COPY, 'utf8')).list || []; } catch { old = []; } }
    for (const id of ids) if (!per[id]) per[id] = old.filter((m) => m.source === id);
    const list = ids.flatMap((id) => per[id] || []);
    catalogue = { at: Date.now(), ids, list, errors };
    if (list.length) { try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(CATALOGUE_COPY, JSON.stringify({ at: catalogue.at, list })); } catch { /* a cache only */ } }
  }
  return catalogue.list.filter((m) => all || want.includes(m.source));
}
/** A source model's catalogue entry from the list already loaded (no network), or null. */
export const sourceInfo = (id) => catalogue?.list.find((m) => m.id === id) || null;
export const catalogueErrors = () => ({ ...(catalogue?.errors || {}) });
// Tests put a list in place of the network's.
export function primeSources(list) { catalogue = { at: Date.now(), ids: [...new Set(list.map((m) => m.source))], list, errors: {} }; }

/** The same model on OpenRouter, when its catalogue has one: what a failed source call falls back to first. */
const VENDOR = { zhipuai: 'z-ai', 'z-ai': 'z-ai', xai: 'x-ai', 'x-ai': 'x-ai', moonshot: 'moonshotai', moonshotai: 'moonshotai', meta: 'meta-llama', mistral: 'mistralai', alibaba: 'qwen', minimax: 'minimax' };
const norm = (s) => String(s || '').toLowerCase().replace(/:.*$/, '').replace(/[._\s]+/g, '-').replace(/-+/g, '-').replace(/-free$/, '');
export function sameOnOpenRouter(id, orList = [], info = sourceInfo(id)) {
  const s = sourceOf(id);
  if (!s) return null;
  const ids = orList.filter((m) => m?.id && !/:(free|batch)$/.test(m.id) && m.tools !== false).map((m) => m.id);
  if (ids.includes(s.model)) return s.model; // Cline's ids are OpenRouter's
  if (s.source === LOCAL_ID && s.model.startsWith('openrouter/') && ids.includes(s.model.slice(11))) return s.model.slice(11); // OpenRouter through OpenCode
  const canon = String(info?.canonical || '');
  const [cv, cm] = canon.includes('/') ? canon.split('/') : ['', canon];
  const want = norm(cm || s.model.split('/').pop());
  const hits = ids.filter((x) => norm(x.split('/').pop()) === want);
  if (!hits.length) return null;
  const v = VENDOR[cv] || cv;
  return hits.find((x) => x.split('/')[0] === v) || hits[0];
}

// ---------- health: what failed lately ----------
const health = new Map(); // source → { ok, at, kind, why, until, model, keyHash, fails }
const clearHealth = (id) => health.delete(id);
// Tests start each case clean.
export const forgetSourceHealth = (id) => (id ? health.delete(id) : health.clear());
/** How a failed call failed: auth, quota, rate, model, server, network, timeout, shape, request. */
export function failureKind(e) {
  if (e?.kind) return e.kind;
  const s = Number(e?.status || e?.streamStatus) || 0, msg = String(e?.message || ''), ty = String(e?.errorType || '');
  // A free model the source keeps for its own app: only that model is set aside.
  if (/FreeUsageLimitError/i.test(ty) || /free (usage )?limit reached|free model usage is not supported|free models are only available|free tier[^.]{0,40}(only|not available)/i.test(msg)) return 'free';
  // OpenCode's error names and Cline's codes say it outright.
  if (/AuthError|invalid_api_key|unauthori[sz]ed/i.test(ty)) return 'auth';
  if (/CreditsError|MonthlyLimitError|UserLimitError|GoUsageLimitError|insufficient_credits/i.test(ty)) return 'quota';
  if (/RateLimitError|rate_limit/i.test(ty)) return 'rate';
  if (/ModelError|model_not_found/i.test(ty)) return 'model';
  if (/RegionError|DataPolicyError|context_length/i.test(ty)) return 'request';
  if (s === 401 || (s === 403 && /auth|key|token|unauthori[sz]ed|forbidden|signature|expired|invalid/i.test(msg))) return 'auth';
  if (s === 402 || ([403, 429].includes(s) && /credit|balance|funds|quota|insufficient|billing|subscri|usage limit|plan limit|limit reached|exceeded your|budget exceeded|clinepass/i.test(msg))) return 'quota';
  if (s === 429) return 'rate';
  if (s === 404 || /model[^.]{0,40}(not found|does not exist|unknown|not supported|unavailable|deprecated|disabled)|no such model|invalid model/i.test(msg)) return 'model';
  if (s >= 500 || s === 408) return 'server';
  if (s >= 400) return 'request';
  if (e?.name === 'TimeoutError') return 'timeout';
  if (/fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket|network|terminated|other side closed|UND_ERR/i.test(msg + String(e?.cause?.code || '') + String(e?.cause?.message || ''))) return 'network';
  return 'unknown';
}
const KIND_WORDS = { notinstalled: 'is not installed on this computer', free: 'keeps that free model for its own app right now', auth: 'refused its key', quota: 'is out of credit or plan usage', rate: 'is rate limiting', model: 'does not have that model now', server: 'had a server error', network: 'could not be reached', timeout: 'did not answer in time', shape: 'answered in a shape QuorX can\'t read', request: 'refused the request', unknown: 'failed' };
export const kindWords = (k) => KIND_WORDS[k] || KIND_WORDS.unknown;
export function noteSourceResult(id, model, err, { now = Date.now() } = {}) {
  const prev = health.get(id) || {};
  if (!err) { health.set(id, { ok: true, at: now, model, fails: 0 }); return; }
  const kind = failureKind(err), fails = (prev.ok === false ? prev.fails || 0 : 0) + 1;
  const retryAfter = Math.min(30 * 60e3, Math.max(0, Number(err?.retryAfter) || 0) * 1000);
  // How long other calls skip this source: a refused key until the key changes (or ten minutes, in case it was the
  // gateway's hiccup); spent credit or plan usage until it resets; a server down for a growing while.
  const wait = kind === 'auth' ? 10 * 60e3 : kind === 'quota' ? retryAfter || 15 * 60e3 : kind === 'rate' ? retryAfter || 30e3
    : kind === 'model' ? 30 * 60e3 : kind === 'shape' ? 5 * 60e3 : kind === 'free' ? Math.min(6 * 3600e3, retryAfter || 6 * 3600e3)
    : ['server', 'network', 'timeout', 'unknown'].includes(kind) ? Math.min(5 * 60e3, 20e3 * 2 ** (fails - 1)) : 0;
  health.set(id, { ok: false, at: now, kind, why: String(err?.message || kind).slice(0, 300), until: wait ? now + wait : 0, model: kind === 'model' || kind === 'shape' || kind === 'free' ? model : null, keyHash: hash(keyFor(id)?.key), fails });
}
/** Why calls should skip this source now (a short reason), or ''. A bad model or shape only skips that model. */
export function sourceSkip(id, model, now = Date.now()) {
  const h = health.get(id);
  if (!h || h.ok) return '';
  if (h.kind === 'auth' && h.keyHash !== hash(keyFor(id)?.key)) return '';
  if (h.model && h.model !== model) return '';
  if (h.until && now < h.until) return `${SOURCES[id].name} ${kindWords(h.kind)} ${Math.max(1, Math.round((now - h.at) / 1000))}s ago (${h.why.slice(0, 120)}); trying it again in ${Math.ceil((h.until - now) / 1000)}s`;
  return '';
}

// ---------- one call ----------
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const stop = () => { clearTimeout(t); reject(new Error('aborted')); };
  const t = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
  signal?.addEventListener('abort', stop, { once: true });
});
const VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch { return '0'; } })();
// QuorX says who it is (its own User-Agent, never another app's) and, for OpenCode, which conversation a call
// belongs to: Go needs a steady session id per chat, and it keeps the gateway's prompt cache warm.
function headersFor(def, format, key, session) {
  const h = { 'Content-Type': 'application/json', Accept: 'text/event-stream, application/json', 'User-Agent': `QuorX/${VERSION}`, Authorization: `Bearer ${key}` };
  if (format === 'anthropic') { h['x-api-key'] = key; h['anthropic-version'] = '2023-06-01'; }
  else if (format === 'google') h['x-goog-api-key'] = key;
  if (def.session && session) h['x-opencode-session'] = session;
  if (def.openrouterLike) { h['HTTP-Referer'] = 'https://quorx.genxmims.org'; h['X-Title'] = 'QuorX'; }
  return h;
}
/** The session id for a conversation: steady for a chat (its id hashed), so each of its calls names the same one. */
export const sessionFor = (key) => `ses_qx${crypto.createHash('sha256').update(String(key || 'quorx')).digest('hex').slice(0, 24)}`;
function urlFor(info, format, def) {
  const base = String(info?.api || def.api[format] || def.api.chat).replace(/\/+$/, '');
  return format === 'anthropic' ? `${base}/messages` : format === 'responses' ? `${base}/responses`
    : format === 'google' ? `${base}/models/${encodeURIComponent(info?.realId || '')}:streamGenerateContent?alt=sse` : `${base}/chat/completions`;
}
// A stream that goes quiet for this long is treated as dead (the gateway's connection hung).
const IDLE_MS = 120e3, HEADERS_MS = 90e3;
function quietGuard(r, ms, ac) {
  let timer = null;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => ac.abort(Object.assign(new Error(`no data for ${Math.round(ms / 1000)} s`), { name: 'TimeoutError' })), ms); };
  return { body: { async *[Symbol.asyncIterator]() { arm(); try { for await (const c of r.body) { arm(); yield c; } } finally { clearTimeout(timer); } } }, headers: r.headers, status: r.status, ok: r.ok };
}
const shape = (msg) => Object.assign(new Error(msg), { kind: 'shape' });

/**
 * One streamed call to the source a model id names, read into openrouter.js chatStream's result shape (with the
 * source's name as `provider` and the call's cost in usage.cost). Throws an Error with .status/.kind on any failure,
 * including an answer QuorX can't read; never falls back by itself (the agent decides that).
 */
export async function sourceStream(body, signal, onText, onThink, { fetchFn = fetch, info: given, session, headersMs = HEADERS_MS, idleMs = IDLE_MS } = {}) {
  const s = sourceOf(body.model);
  if (!s) throw Object.assign(new Error(`${body.model} is not a source model`), { kind: 'request' });
  // The OpenCode on this computer needs no key: its own sign-ins make the call.
  if (s.def.local) {
    if (!given && !sourceInfo(body.model)) await sourceModels().catch(() => []);
    const info = given || sourceInfo(body.model) || { plan: 'paid' };
    const out = await localStream(body, signal, onText, onThink, { info, idleMs: Math.max(idleMs, 180e3) });
    out.usage = { ...(out.usage || {}), ...(Object.keys(out.usage || {}).length ? priced(info, out.usage) : {}) };
    out.source = s.source;
    return out;
  }
  const def = s.def, k = keyFor(s.source);
  if (!k) throw Object.assign(new Error(`${def.name} has no key in QuorX (⚙ Settings → OpenCode & Cline)`), { kind: 'auth' });
  // Its catalogue entry says which format and address the model takes: right after a restart (a summary or a brief
  // before anything loaded the list) it is loaded first.
  if (!given && !sourceInfo(body.model)) await sourceModels().catch(() => []);
  const info = given || sourceInfo(body.model) || { id: body.model, realId: s.model, source: s.source, format: 'chat', api: def.api.chat };
  const format = info.format && BUILD[info.format] ? info.format : 'chat';
  // The agent passes its chat's session; a call from elsewhere (a brief, a test) takes one from its first message.
  const ses = session || sessionFor(JSON.stringify(body.messages?.find((m) => m.role === 'user')?.content ?? '').slice(0, 4000));
  const req = BUILD[format]({ ...body, model: s.model }, { ...info, realId: s.model, source: s.source }, { openrouterLike: !!def.openrouterLike, session: def.session ? ses : null });
  const t = Date.now();
  // A short wait and one more try for a hiccup (rate limit with a short Retry-After, a 5xx, a dropped connection),
  // as long as nothing has reached the page yet; anything longer is the agent's to decide (it falls back).
  for (let attempt = 0; ; attempt++) {
    const ac = new AbortController();
    const stop = () => ac.abort(signal.reason);
    signal?.addEventListener('abort', stop, { once: true });
    const headTimer = setTimeout(() => ac.abort(Object.assign(new Error(`${def.name} sent nothing for ${Math.round(headersMs / 1000)} s`), { name: 'TimeoutError' })), headersMs);
    let streamed = false;
    const tap = (fn) => (fn ? (d) => { streamed = true; fn(d); } : null);
    // Reading a whole body (an error, or an answer that came back whole) has a limit too.
    const whole = async (r) => { const tm = setTimeout(() => ac.abort(Object.assign(new Error(`${def.name} stopped sending for ${Math.round(idleMs / 1000)} s`), { name: 'TimeoutError' })), idleMs); try { return await r.text(); } finally { clearTimeout(tm); } };
    try {
      let r;
      try { r = await fetchFn(urlFor(info, format, def), { method: 'POST', headers: headersFor(def, format, k.key, ses), body: JSON.stringify(req), signal: ac.signal }); }
      finally { clearTimeout(headTimer); }
      if (!r.ok) {
        const raw = await whole(r).catch(() => '');
        let j = null; try { j = JSON.parse(raw); } catch { /* not JSON */ }
        const e = Object.assign(new Error(j ? errorText(j, r.status) : /<html|<!doctype/i.test(raw) ? `HTTP ${r.status} (a web page instead of an answer)` : `HTTP ${r.status}${raw ? `: ${raw.replace(/\s+/g, ' ').slice(0, 160)}` : ''}`), { status: r.status });
        // OpenCode names its errors (GoUsageLimitError, CreditsError…); Cline uses codes (insufficient_credits).
        const ty = j?.error?.type || j?.error?.code || j?.type;
        if (ty && typeof ty === 'string' && ty !== 'error') e.errorType = ty;
        const ra = Number(r.headers?.get?.('retry-after'));
        if (Number.isFinite(ra) && ra > 0) e.retryAfter = ra;
        throw e;
      }
      const type = String(r.headers?.get?.('content-type') || '');
      let out;
      if (/json/i.test(type) && !/event-stream/i.test(type)) {
        const raw = await whole(r);
        let j; try { j = JSON.parse(raw); } catch { throw shape(`${def.name} sent JSON QuorX could not read`); }
        if (j?.error) throw Object.assign(new Error(errorText(j, r.status)), { status: Number(j.error?.code) || null });
        out = readWhole(format, j, t, tap(onText), tap(onThink));
        if (!out) throw shape(`${def.name} answered in a shape QuorX doesn't know (${Object.keys(j || {}).slice(0, 6).join(', ') || 'empty'})`);
      } else if (/html/i.test(type)) {
        throw shape(`${def.name} sent a web page instead of an answer`);
      } else {
        out = await READ[format](quietGuard(r, idleMs, ac), req, t, tap(onText), tap(onThink));
        if (!out.seen) throw shape(`${def.name}'s answer had nothing QuorX could read`);
      }
      out.toolCalls = (out.toolCalls || []).filter((c) => c?.function?.name && typeof c.function.name === 'string').map((c, i) => ({ ...c, id: c.id || `call_${t.toString(36)}_${i}` }));
      if (!out.text && !out.toolCalls.length && !out.finishReason && !Object.keys(out.usage || {}).length && !out.thinking) throw shape(`${def.name} ended its answer without any text, tool call or reason`);
      // What the next step of the same model needs back, and what this call cost.
      if (format === 'chat' && info.interleaved && typeof info.interleaved === 'string' && out.thinking) out.passBack = { ...(out.passBack || {}), thinking: out.thinking };
      if (out.passBack) out.passBack = { ...out.passBack, source: s.source, model: s.model };
      // No usage at all (the gateway left the last chunk out): the agent counts it at an estimate instead.
      out.usage = out.partial && !Object.keys(out.usage || {}).length ? {} : { ...(out.usage || {}), ...priced(info, out.usage) };
      out.provider = def.name;
      out.source = s.source;
      out.model = body.model;
      return out;
    } catch (e0) {
      const e = e0 && typeof e0 === 'object' ? e0 : new Error(String(e0));
      if (signal?.aborted) throw e;
      if (ac.signal.aborted && ac.signal.reason?.name === 'TimeoutError') { e.kind = 'timeout'; e.message = ac.signal.reason.message; }
      e.source = s.source;
      const kind = failureKind(e);
      const wait = kind === 'rate' ? (e.retryAfter || 2) * 1000 : ['server', 'network'].includes(kind) ? 1500 : -1;
      if (attempt === 0 && !streamed && wait >= 0 && wait <= 8000) { await sleep(wait, signal); continue; }
      throw e;
    } finally { signal?.removeEventListener('abort', stop); }
  }
}
/**
 * What a call cost: the source's own figure when it sends one (OpenCode and Cline both do, as usage.cost), else its
 * tokens at the catalogue's prices (context tiers too). A plan model (OpenCode Go, ClinePass) costs nothing per call
 * unless the source says it billed it (Go's "extra usage" can draw on credit); plan_cost is what it counted against
 * the plan's limits, at list price.
 */
export function priced(info, u = {}) {
  const said = u.cost !== null && u.cost !== '' && u.cost !== undefined && Number.isFinite(Number(u.cost)) ? Number(u.cost) : null;
  if (info?.plan === 'plan') {
    const oc = u.opencode || {}, plan = Number(oc.allowance ?? oc.list_cost);
    return { cost: said ?? 0, plan_cost: Number.isFinite(plan) ? plan : costOf(info, u) };
  }
  if (said != null) return { cost: said };
  if (info?.plan === 'free') return { cost: 0 };
  return { cost: costOf(info, u), estimated_cost: true };
}
function costOf(info, u) {
  const c = info?.cost || {}, prompt = Number(u.prompt_tokens) || 0, out = Number(u.completion_tokens) || 0;
  const read = Number(u.prompt_tokens_details?.cached_tokens ?? u.cache_read_input_tokens) || 0, write = Number(u.prompt_tokens_details?.cache_write_tokens ?? u.cache_creation_input_tokens) || 0;
  const tier = (Array.isArray(c.tiers) ? c.tiers : []).filter((x) => prompt > Number(x?.tier?.size || Infinity)).sort((a, b) => b.tier.size - a.tier.size)[0] || c;
  const p = (k) => per(tier[k] ?? c[k]);
  const fresh = Math.max(0, prompt - read - write);
  return (fresh * p('input') + read * (tier.cache_read != null || c.cache_read != null ? p('cache_read') : p('input')) + write * (tier.cache_write != null || c.cache_write != null ? p('cache_write') : p('input')) + out * p('output')) / 1e6;
}

// ---------- what Settings shows ----------
export async function sourceStatus({ versions = true } = {}) {
  const s = load();
  // The apps' versions: looked up when Settings shows this page, else whatever was found last.
  const [oc, cl] = versions ? await Promise.all([appVersion('opencode'), appVersion('cline')]) : [apps.get('opencode')?.v ?? null, apps.get('cline')?.v ?? null];
  const has = openCodeHas(), signed = clineSignedIn();
  const models = catalogue?.list || [];
  return SOURCE_IDS.map((id) => {
    const def = SOURCES[id], k = keyFor(id), h = health.get(id);
    return {
      id, name: def.name, short: def.short, app: def.app, billing: def.billing, site: def.site, keyUrl: def.keyUrl, docs: def.docs, keyHint: def.keyHint,
      on: !!s[id]?.on, key: k ? { masked: mask(k.key), from: k.from } : null, ...(def.local ? { local: true, installed: !!findOnPath('opencode'), server: localServer() } : {}),
      app_: def.app === 'opencode' ? (oc ? { installed: true, version: oc.version } : { installed: false }) : (cl ? { installed: true, version: cl.version } : { installed: false }),
      // OpenCode's one key serves pay as you go and Go, so a key for either can be used for both.
      found: def.app === 'opencode' ? { openCodeKey: has.length > 0 } : { clineSignedIn: !!signed },
      models: models.filter((m) => m.source === id).length, catalogueError: catalogue?.errors?.[id] || null,
      last: h ? { ok: !!h.ok, at: h.at, kind: h.kind || null, why: h.why || null, until: h.until || 0, model: h.model || null } : null,
    };
  });
}
/**
 * Checks a connection. Cline says whether a key is good without a paid call (its account page); OpenCode has no such
 * page, so a tiny call goes to its cheapest chat model (a Go model costs nothing; a pay-as-you-go one well under a cent).
 */
export async function testSource(id, { model, fetchFn = fetch } = {}) {
  known(id);
  const def = SOURCES[id], k = keyFor(id), t = Date.now();
  // The OpenCode on this computer: starting its server and listing its providers' models costs nothing.
  if (def.local) {
    try {
      await ensureLocalServer();
      const list = await localModels();
      noteSourceResult(id, null, null);
      return { ok: true, how: 'local', ms: Date.now() - t, cost: 0, models: list.length, providers: [...new Set(list.map((m) => m.providerName))] };
    } catch (e) { noteSourceResult(id, null, e); return { ok: false, kind: failureKind(e), error: String(e.message || e).slice(0, 300) }; }
  }
  if (!k) return { ok: false, kind: 'auth', error: `Add a key for ${def.name} first.` };
  if (def.me && !model) {
    try {
      const r = await fetchFn(def.me, { headers: { Authorization: `Bearer ${k.key}`, Accept: 'application/json', 'User-Agent': `QuorX/${VERSION}` }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) {
        const raw = await r.text().catch(() => '');
        let j = null; try { j = JSON.parse(raw); } catch { /* not JSON */ }
        throw Object.assign(new Error(j ? errorText(j, r.status) : `HTTP ${r.status}`), { status: r.status });
      }
      noteSourceResult(id, null, null);
      return { ok: true, how: 'account', ms: Date.now() - t, cost: 0 };
    } catch (e) {
      noteSourceResult(id, null, e);
      return { ok: false, kind: failureKind(e), error: String(e.message || e).slice(0, 300) };
    }
  }
  const list = await sourceModels({ all: true }).catch(() => []);
  // Never a free model: a source that keeps those for its own app would make a good key look broken.
  const mine = list.filter((m) => m.source === id && m.status !== 'deprecated' && m.plan !== 'free');
  // Plan models first (nothing to pay), then the cheapest at list price; chat models before the other formats.
  const rank = (m) => (m.plan === 'plan' ? 0 : 1) * 10 + (m.format === 'chat' ? 0 : 1);
  const pick = model ? mine.find((m) => m.id === model) : [...mine].sort((a, b) => rank(a) - rank(b) || (a.listPrice[0] + a.listPrice[1]) - (b.listPrice[0] + b.listPrice[1]))[0];
  if (!pick) return { ok: false, kind: 'model', error: `${def.name} has no model QuorX can test with${catalogue?.errors?.[id] ? ` (${catalogue.errors[id]})` : ''}.` };
  const ac = new AbortController(), timer = setTimeout(() => ac.abort(Object.assign(new Error('no answer in 60 s'), { name: 'TimeoutError' })), 60e3);
  try {
    const r = await sourceStream({ model: pick.id, max_tokens: 64, messages: [{ role: 'user', content: 'Reply with the word ready.' }] }, ac.signal, null, null, { fetchFn, info: pick, session: sessionFor('quorx-test') });
    noteSourceResult(id, pick.id, null);
    return { ok: true, how: 'call', model: pick.id, ms: Date.now() - t, text: String(r.text || '').slice(0, 80), cost: r.usage?.cost || 0 };
  } catch (e) {
    if (ac.signal.reason?.name === 'TimeoutError') e.kind = 'timeout';
    noteSourceResult(id, pick.id, e);
    return { ok: false, model: pick.id, kind: failureKind(e), error: String(e.message || e).slice(0, 300) };
  } finally { clearTimeout(timer); }
}

// ---------- a whole answer (summaries, briefs), with the fallback ----------
const stripPass = (msgs) => (msgs || []).map((m) => { if (!m || typeof m !== 'object' || !('qx_pass' in m)) return m; const { qx_pass: _q, ...rest } = m; return rest; });
export { stripPass };
/**
 * A non-streamed call for any model: OpenRouter's chat() for its models; a source model through its source, and on
 * failure through OpenRouter with `fallback(id)` (when that gives a model). Answers like chat(): { message, usage, ms },
 * plus { model, fellBack, why } saying which model really answered.
 */
export async function chatAny(body, signal, { orChat, fallback, stream = sourceStream, checkOn = stream === sourceStream } = {}) {
  if (!isSourceModel(body.model)) { const r = await orChat({ ...body, messages: stripPass(body.messages) }, signal); return { ...r, model: body.model }; }
  const src = sourceOf(body.model).source;
  const skip = checkOn && !sourceOn(src) ? `${SOURCES[src].name} is switched off or has no key` : sourceSkip(src, body.model);
  let why = skip;
  if (!skip) {
    try {
      const r = await stream(body, signal || new AbortController().signal);
      noteSourceResult(sourceOf(body.model).source, body.model, null);
      return { message: { role: 'assistant', content: r.text, ...(r.toolCalls.length ? { tool_calls: r.toolCalls } : {}) }, usage: r.usage, ms: r.ms, model: body.model };
    } catch (e) {
      if (signal?.aborted) throw e;
      noteSourceResult(sourceOf(body.model).source, body.model, e);
      why = `${SOURCES[sourceOf(body.model).source].name} ${kindWords(failureKind(e))}: ${String(e.message || e).slice(0, 160)}`;
    }
  }
  const fb = await fallback?.(body.model);
  if (!fb) throw Object.assign(new Error(why), { status: 400 });
  const r = await orChat({ ...body, model: fb, messages: stripPass(body.messages) }, signal);
  return { ...r, model: fb, fellBack: true, why };
}
