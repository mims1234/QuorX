// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Model sources: where a chat's main model runs. OpenRouter is the default and stays behind everything else QuorX
// does (deciders, media, helpers, the reviewer, every fallback). An app on this computer can run the main model with
// the providers, plans and sign-ins the user connected there: the OpenCode app (opencodelocal.js), Claude Code
// (claudelocal.js) and Grok Build (groklocal.js). OpenCode Go runs over its API with the user's own key (opencodego.js).
//   - The OpenCode app on this computer is retired: its models show nowhere, and a chat still set to one is told to
//     pick another (a Go model it ran through the app moves to Go over the API when a Go key is in).
//   - A source model's id is the source, a slash, and the model as that app names it:
//     opencode-local/deepseek/deepseek-v4-flash. OpenRouter has no vendor by that name, so the id alone says where a
//     call goes and every picker, chat and schedule just works.
//   - QuorX holds no key for an app: the app makes each call itself. data/sources.json says which are on, and holds
//     the OpenCode Go key (the page only ever sees it masked; agent processes never get it).
//   - When a source fails, the reply stops and says why, unless the user chose a fallback to OpenRouter (agent.js).
//     What failed is kept here, so other chats skip a model that is down instead of waiting on it.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { HOME } from './openrouter.js';
import { renameSoon } from './fsretry.js';
import { findOnPath, localModels, localStream, ensureLocalServer, localServer, LOCAL_ID, SETTING_REFUSAL } from './opencodelocal.js';
import { claudeModels, claudeStream, claudeAuth, claudeRunning, CLAUDE_ID } from './claudelocal.js';
import { grokModels, grokStream, grokRunning, GROK_ID } from './groklocal.js';
import { goModels, goStream, goCheck, GO_ID } from './opencodego.js';

const DATA = path.join(HOME, 'data');
export const SOURCE_FILE = path.join(DATA, 'sources.json');

// What QuorX knows about each source.
export const SOURCES = {
  // The OpenCode app on this computer (opencodelocal.js): every provider connected there.
  [LOCAL_ID]: {
    id: LOCAL_ID, name: 'OpenCode on this PC', short: 'This PC', app: 'opencode', billing: 'mixed', local: true,
    site: 'https://opencode.ai', keyUrl: 'https://opencode.ai/docs/providers/', docs: 'https://opencode.ai/docs/server/',
    keyHint: 'No key: QuorX uses the providers you connected in OpenCode (opencode auth login).', install: 'npm i -g opencode-ai', appName: 'OpenCode',
    // Not offered any more: its models show nowhere, and a chat still on one is told to pick another.
    retired: 'OpenCode on this PC is no longer offered in QuorX. Pick another model in the chat\'s model button (OpenCode Go models run with your Go key: ⚙ Settings → API keys).',
  },
  // OpenCode Go over its API (opencodego.js), with the key from the user's Go workspace.
  [GO_ID]: {
    id: GO_ID, name: 'OpenCode Go', short: 'Go', app: null, billing: 'plan', local: false, needsKey: true, env: 'OPENCODE_API_KEY',
    site: 'https://opencode.ai/go', keyUrl: 'https://opencode.ai/console', docs: 'https://opencode.ai/docs/go/',
    keyHint: 'An API key from the OpenCode Console workspace that has your Go subscription (opencode.ai/console → API keys).',
  },
  // Claude Code on this computer (claudelocal.js): the subscription or API key it is signed in with.
  [CLAUDE_ID]: {
    id: CLAUDE_ID, name: 'Claude Code on this PC', short: 'Claude Code', app: 'claude', billing: 'mixed', local: true,
    site: 'https://claude.com/product/claude-code', keyUrl: 'https://code.claude.com/docs/en/setup', docs: 'https://code.claude.com/docs/en/headless',
    keyHint: 'No key: QuorX uses the account you signed in to Claude Code with.', install: 'npm i -g @anthropic-ai/claude-code', appName: 'Claude Code',
  },
  // Grok Build on this computer (groklocal.js): the account it is signed in with (grok login).
  [GROK_ID]: {
    id: GROK_ID, name: 'Grok Build on this PC', short: 'Grok Build', app: 'grok', billing: 'mixed', local: true,
    site: 'https://x.ai/cli', keyUrl: 'https://x.ai/cli', docs: 'https://x.ai/cli',
    keyHint: 'No key: QuorX uses the account you signed in to Grok Build with (grok login).', install: 'curl -fsSL https://x.ai/cli/install.sh | bash', appName: 'Grok Build',
    // Its models see no pictures here and stop short of long calls (a drawing's strokes), so a chat on one doesn't get
    // the desktop tool: the model says it can't, instead of starting and stalling.
    noDesktop: 'Grok Build models in QuorX read text only and stop short of long steps like drawing, so 🖥 Computer use is off with them. Pick a Claude Code model, or an OpenRouter model that sees pictures, to use apps on this computer.',
  },
};
// How QuorX reaches each app: its model list, one call, a check that costs nothing, and what its process is doing.
const APPS = {
  [LOCAL_ID]: { list: () => localModels(), stream: localStream, check: () => ensureLocalServer(), server: localServer },
  [CLAUDE_ID]: { list: () => claudeModels(), stream: claudeStream, check: () => claudeAuth({ refresh: true }), server: () => ({ running: claudeRunning() > 0, calls: claudeRunning(), perCall: true }) },
  // Listing Grok's models starts it and signs in, so it is the check too.
  [GROK_ID]: { list: () => grokModels(), stream: grokStream, check: async () => {}, server: () => ({ running: grokRunning() > 0, calls: grokRunning(), perCall: true }) },
  // Go's list is public; a call and the check need the key.
  [GO_ID]: { list: () => goModels(), stream: (b, sg, t, th, o) => goStream(b, sg, t, th, { ...o, key: keyFor(GO_ID)?.key }), check: async () => { const k = keyFor(GO_ID)?.key; if (!k) throw Object.assign(new Error('Add your OpenCode Go key first.'), { kind: 'auth' }); await goCheck(k, await goModels()); }, server: () => ({ api: true }) },
};
// The sources Settings and the pickers offer (a retired one is still recognised in a model id, to say so).
export const SOURCE_IDS = Object.keys(SOURCES).filter((id) => !SOURCES[id].retired);

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

// ---------- which are on (data/sources.json) ----------
function load() { try { return JSON.parse(fs.readFileSync(SOURCE_FILE, 'utf8')) || {}; } catch { return {}; } }
function save(s) {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(SOURCE_FILE + '.tmp', JSON.stringify(s, null, 2));
  renameSoon(SOURCE_FILE + '.tmp', SOURCE_FILE);
}
// The key a source with one uses: the one saved here, else its environment variable.
export function keyFor(id) {
  const def = SOURCES[id];
  if (!def?.needsKey) return null;
  const k = load()[id]?.key;
  if (typeof k === 'string' && k) return { key: k, from: 'pasted' };
  if (def.env && process.env[def.env]) return { key: process.env[def.env], from: 'env' };
  return null;
}
const mask = (k) => (k.length > 16 ? `${k.slice(0, 6)}••••••••${k.slice(-4)}` : '••••••••');
// Whether it can run at all: an app installed on this computer, or a key for an API.
const ready = (id) => { const d = SOURCES[id]; return !!d && !d.retired && (d.needsKey ? !!keyFor(id) : !!findOnPath(d.app)); };
/** Whether a source's models show in the pickers: switched on, and its app installed (or its key in). */
export const sourceOn = (id) => !!load()[id]?.on && ready(id);
/** Why a source's models can't run now (retired, no key, not installed, switched off), or ''. */
export function sourceOffWhy(id) {
  const d = SOURCES[id];
  if (!d) return 'no such source';
  if (d.retired) return d.retired;
  if (d.needsKey && !keyFor(id)) return `${d.name} has no key yet (⚙ Settings → API keys)`;
  if (!d.needsKey && !findOnPath(d.app)) return `${d.name} is not installed (⚙ Settings → Apps on this PC)`;
  return sourceOn(id) ? '' : `${d.name} is switched off (⚙ Settings → ${d.needsKey ? 'API keys' : 'Apps on this PC'})`;
}
// What is kept: each source's switch, and the key of one that takes a key. Anything else an older version saved here goes.
const tidy = (all) => Object.fromEntries(Object.entries(all).filter(([k]) => Object.hasOwn(SOURCES, k)).map(([k, v]) => [k, { on: !!v?.on, ...(SOURCES[k].needsKey && typeof v?.key === 'string' && v.key ? { key: v.key, added: v.added || 0 } : {}) }]));
export function setSourceOn(id, on) {
  known(id);
  const d = SOURCES[id];
  if (on && d.retired) throw new Error(d.retired);
  if (on && d.needsKey && !keyFor(id)) throw new Error(`Add your ${d.name} key first.`);
  if (on && !d.needsKey && !findOnPath(d.app)) throw new Error(`${d.appName} is not installed on this computer (${d.install}).`);
  const s = tidy(load());
  s[id] = { ...(s[id] || {}), on: !!on };
  save(s);
  clearHealth(id);
  dropCatalogue(id);
}
/** Saves the key of a source that takes one, and switches it on. */
export function setSourceKey(id, key) {
  known(id);
  const d = SOURCES[id];
  if (!d.needsKey) throw new Error(`${d.name} takes no key.`);
  key = String(key || '').trim();
  if (key.length < 16 || key.length > 400 || /\s/.test(key)) throw new Error(`That does not look like a key. ${d.keyHint}`);
  if (/^sk-or-/.test(key)) throw new Error('That is an OpenRouter key: add it under OpenRouter keys instead.');
  const s = tidy(load());
  s[id] = { on: true, key, added: Date.now() };
  save(s);
  clearHealth(id);
  dropCatalogue(id);
}
/** Removes a saved key. The source stays on only if its environment variable still gives one. */
export function removeSourceKey(id) {
  known(id);
  const s = tidy(load());
  if (s[id]) { delete s[id].key; delete s[id].added; }
  save(s);
  if (s[id]?.on && !keyFor(id)) { s[id].on = false; save(s); }
  clearHealth(id);
  dropCatalogue(id);
}
/**
 * The model a chat set to a retired source's model runs on now: a Go model the OpenCode app ran
 * (opencode-local/opencode-go/glm-5.3) moves to Go over the API when Go is on. Anything else stays as it is.
 */
export function movedModel(id) {
  const s = sourceOf(id);
  if (s?.source !== LOCAL_ID || !s.model.startsWith(`${GO_ID}/`) || !sourceOn(GO_ID)) return id;
  return `${GO_ID}/${s.model.slice(GO_ID.length + 1)}`;
}

// ---------- the apps on this computer ----------
// "opencode --version", found on PATH (cached ten minutes).
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
let catalogue = null; // { at: { source: when listed }, ids, list, errors }
// A source whose switch changed is listed again on the next call; the others keep their lists.
const dropCatalogue = (id) => { if (catalogue) catalogue = { ...catalogue, ids: catalogue.ids.filter((x) => x !== id) }; };
const per = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
// How each source lists its models (the app itself, started when needed).
const LISTERS = Object.fromEntries(Object.entries(APPS).map(([id, a]) => [id, a.list]));
let refreshing = null; // the refresh under way: { ids, p }
function refreshLists(ids, listers) {
  if (refreshing && ids.every((id) => refreshing.ids.includes(id))) return refreshing.p;
  const after = refreshing?.p || Promise.resolve();
  const job = { ids, p: after.catch(() => {}).then(async () => {
    const got = {}, errors = {};
    // Listing a source starts its app, which Settings alone never should: only one switched on is listed.
    await Promise.all(ids.filter((id) => sourceOn(id)).map((id) => Promise.resolve().then(() => (listers[id] || LISTERS[id])()).then((l) => { got[id] = l; }, (e) => { errors[id] = e.message; })));
    const now = Date.now(), at = { ...(catalogue?.at || {}) }, errs = { ...(catalogue?.errors || {}) }, old = catalogue?.list || [];
    for (const id of ids) {
      at[id] = now;
      if (!sourceOn(id)) { delete errs[id]; got[id] = []; continue; }
      if (got[id]?.length) { delete errs[id]; continue; }
      // A list that failed, or came back empty, keeps its last good copy.
      errs[id] = errors[id] || `${SOURCES[id].name} listed no models QuorX can use`;
      got[id] = old.filter((m) => m.source === id);
    }
    const keepIds = (catalogue?.ids || []).filter((id) => !ids.includes(id));
    catalogue = { at, ids: [...keepIds, ...ids], list: [...old.filter((m) => keepIds.includes(m.source)), ...ids.flatMap((id) => got[id] || [])], errors: errs };
  }).finally(() => { if (refreshing === job) refreshing = null; }) };
  refreshing = job;
  return job.p;
}
/**
 * The models of every source that is switched on. A good list lasts an hour and a failed one is tried again after a
 * minute, in the background: the last list is answered at once, so a slow app never holds up a reply. Only a source
 * with no list yet (or `refresh`) is waited for. `all`: every source, on or not (Settings shows how many each has).
 * `listers`: tests put their own lists in place of the apps'.
 */
export async function sourceModels({ refresh = false, all = false, listers = {} } = {}) {
  const want = SOURCE_IDS.filter((id) => all || sourceOn(id));
  if (!want.length) return [];
  const now = Date.now();
  const missing = want.filter((id) => !catalogue?.ids.includes(id));
  const stale = want.filter((id) => !missing.includes(id) && now - (catalogue.at?.[id] || 0) > (catalogue.errors?.[id] ? 60e3 : 3600e3));
  if (refresh) await refreshLists(want, listers);
  else {
    if (missing.length) await refreshLists(missing, listers);
    if (stale.length) refreshLists(stale, listers).catch(() => {});
  }
  return catalogue.list.filter((m) => want.includes(m.source));
}
/** A source model's catalogue entry from the list already loaded, or null. */
export const sourceInfo = (id) => catalogue?.list.find((m) => m.id === id) || null;
export const catalogueErrors = () => ({ ...(catalogue?.errors || {}) });
// Tests put a list in place of the apps'.
export function primeSources(list) { const ids = [...new Set(list.map((m) => m.source))]; catalogue = { at: Object.fromEntries(ids.map((id) => [id, Date.now()])), ids, list, errors: {} }; }

/** The same model on OpenRouter, when its catalogue has one: what a failed source call falls back to first. */
const VENDOR = { zhipuai: 'z-ai', 'z-ai': 'z-ai', xai: 'x-ai', 'x-ai': 'x-ai', moonshot: 'moonshotai', moonshotai: 'moonshotai', meta: 'meta-llama', mistral: 'mistralai', alibaba: 'qwen', minimax: 'minimax' };
const norm = (s) => String(s || '').toLowerCase().replace(/:.*$/, '').replace(/[._\s]+/g, '-').replace(/-+/g, '-').replace(/-free$/, '');
export function sameOnOpenRouter(id, orList = [], info = sourceInfo(id)) {
  const s = sourceOf(id);
  if (!s) return null;
  const ids = orList.filter((m) => m?.id && !/:(free|batch)$/.test(m.id) && m.tools !== false).map((m) => m.id);
  if (s.model.startsWith('openrouter/') && ids.includes(s.model.slice(11))) return s.model.slice(11); // OpenRouter through OpenCode
  if (ids.includes(s.model)) return s.model;
  const canon = String(info?.canonical || '');
  const [cv, cm] = canon.includes('/') ? canon.split('/') : [info?.providerID || s.model.split('/')[0], canon];
  const want = norm(cm || s.model.split('/').pop());
  const hits = ids.filter((x) => norm(x.split('/').pop()) === want);
  if (!hits.length) return null;
  const v = VENDOR[cv] || cv;
  return hits.find((x) => x.split('/')[0] === v) || hits[0];
}

// ---------- health: what failed lately ----------
const health = new Map(); // source → { ok, at, kind, why, until, model, scoped, fails }: its last result
const modelHealth = new Map(); // `${source}|${model}` → the same, for failures that only one model had
const dropModels = (id) => { for (const k of [...modelHealth.keys()]) if (k.startsWith(`${id}|`)) modelHealth.delete(k); };
const clearHealth = (id) => { health.delete(id); dropModels(id); };
// Tests start each case clean.
export const forgetSourceHealth = (id) => (id ? clearHealth(id) : (health.clear(), modelHealth.clear()));
/** How a failed call failed: auth, quota, rate, model, server, network, timeout, shape, request, free, notinstalled. */
export function failureKind(e) {
  if (e?.kind) return e.kind;
  const s = Number(e?.status || e?.streamStatus) || 0, msg = String(e?.message || ''), ty = String(e?.errorType || '');
  // A free model its provider keeps for its own app: only that model is set aside.
  if (/FreeUsageLimitError/i.test(ty) || /free (usage )?limit reached|free model usage is not supported|free models are only available|free tier[^.]{0,40}(only|not available)/i.test(msg)) return 'free';
  // Refused by a setting in the user's account there ("This Go model requires Global regions. Select Global in your
  // workspace's Privacy settings"): theirs to change, whatever status it came with, and not an outage.
  if (SETTING_REFUSAL.test(msg)) return 'setting';
  // The provider's own error names say it outright (OpenCode passes them on).
  if (/AuthError|invalid_api_key|unauthori[sz]ed/i.test(ty)) return 'auth';
  if (/CreditsError|MonthlyLimitError|UserLimitError|GoUsageLimitError|insufficient_credits/i.test(ty)) return 'quota';
  if (/RateLimitError|rate_limit/i.test(ty)) return 'rate';
  if (/ModelError|model_not_found/i.test(ty)) return 'model';
  if (/RegionError|DataPolicyError|context_length/i.test(ty)) return 'request';
  if (s === 401 || (s === 403 && /auth|key|token|unauthori[sz]ed|forbidden|signature|expired|invalid/i.test(msg))) return 'auth';
  if (s === 402 || ([403, 429].includes(s) && /credit|balance|funds|quota|insufficient|billing|subscri|usage limit|plan limit|limit reached|exceeded your|budget exceeded/i.test(msg))) return 'quota';
  if (s === 429) return 'rate';
  if (s >= 500 || s === 408) return 'server';
  if (s === 404 || /model[^.]{0,40}(not found|does not exist|unknown|not supported|unavailable|deprecated|disabled)|no such model|invalid model/i.test(msg)) return 'model';
  if (s >= 400) return 'request';
  if (e?.name === 'TimeoutError') return 'timeout';
  if (/fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket|network|terminated|other side closed|UND_ERR/i.test(msg + String(e?.cause?.code || '') + String(e?.cause?.message || ''))) return 'network';
  return 'unknown';
}
const KIND_WORDS = { notinstalled: 'is not installed on this computer', free: 'keeps that free model for its own app right now', auth: 'refused its key', quota: 'is out of credit or plan usage', rate: 'is rate limiting', model: 'does not have that model now', server: 'had a server error', network: 'could not be reached', timeout: 'did not answer in time', shape: 'answered in a shape QuorX can\'t read', request: 'refused the request', setting: 'refused it because of a setting in your account there', unknown: 'failed' };
export const kindWords = (k) => KIND_WORDS[k] || KIND_WORDS.unknown;
// Each model of an app runs on its own provider, so a refused key, a spent plan or an outage is that model's: it is
// set aside and the rest keep working. Only the app itself missing or unreachable is the whole source's.
const SOURCE_KINDS = new Set(['notinstalled', 'network']);
export function noteSourceResult(id, model, err, { now = Date.now() } = {}) {
  if (!err) { health.set(id, { ok: true, at: now, model, fails: 0 }); if (model) modelHealth.delete(`${id}|${model}`); return; }
  const kind = failureKind(err), scoped = !SOURCE_KINDS.has(kind);
  // A model-sized failure with no model named (the connection test) is shown in Settings but skips nothing.
  const key = scoped ? (model ? `${id}|${model}` : null) : id;
  const prev = (key && (scoped ? modelHealth.get(key) : (health.get(key)?.scoped ? null : health.get(key)))) || {};
  const fails = (prev.ok === false ? prev.fails || 0 : 0) + 1;
  const retryAfter = Math.min(30 * 60e3, Math.max(0, Number(err?.retryAfter) || 0) * 1000);
  // How long other calls skip it: a refused key for ten minutes; spent credit or plan usage until it resets; a
  // server down for a growing while.
  const wait = kind === 'auth' ? 10 * 60e3 : kind === 'quota' ? retryAfter || 15 * 60e3 : kind === 'rate' ? retryAfter || 30e3
    : kind === 'model' ? 30 * 60e3 : kind === 'shape' ? 5 * 60e3 : kind === 'free' ? Math.min(6 * 3600e3, retryAfter || 6 * 3600e3)
    : ['server', 'network', 'timeout', 'unknown', 'notinstalled'].includes(kind) ? Math.min(5 * 60e3, 20e3 * 2 ** (fails - 1)) : 0;
  const rec = { ok: false, at: now, kind, why: String(err?.message || kind).slice(0, 300), until: wait && key ? now + wait : 0, model: scoped ? model || null : null, scoped, fails };
  if (scoped && key) modelHealth.set(key, rec);
  // Settings shows the last result either way; only a source-wide one makes other models skip.
  health.set(id, scoped ? { ...rec, until: 0 } : rec);
}
const skipWhy = (id, h, now) => `${SOURCES[id].name} ${kindWords(h.kind)} ${Math.max(1, Math.round((now - h.at) / 1000))}s ago (${h.why.slice(0, 120)}); trying it again in ${Math.ceil((h.until - now) / 1000)}s`;
/** Why calls should skip this source now (a short reason), or ''. A model-sized failure only skips that model. */
export function sourceSkip(id, model, now = Date.now()) {
  const h = health.get(id);
  if (h && !h.ok && !h.scoped && h.until && now < h.until) return skipWhy(id, h, now);
  const m = model ? modelHealth.get(`${id}|${model}`) : null;
  if (m && m.until && now < m.until) return skipWhy(id, m, now);
  return '';
}

// ---------- one call ----------
/** The session id for a conversation: steady for a chat (its id hashed). */
export const sessionFor = (key) => `ses_qx${crypto.createHash('sha256').update(String(key || 'quorx')).digest('hex').slice(0, 24)}`;
// Stop pressed before (or while) a call is set up: nothing goes out. An abort listener alone never fires for a signal
// that is already aborted.
const stopped = (signal) => { if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Stopped.'); };
/**
 * One streamed call through the app a model id names, read into openrouter.js chatStream's result shape (with the
 * call's cost in usage.cost). Throws an Error with .status/.kind on any failure; never falls back by itself (the
 * agent decides that).
 */
export async function sourceStream(body, signal, onText, onThink, { info: given, idleMs = 180e3 } = {}) {
  stopped(signal);
  const s = sourceOf(body.model);
  if (!s) throw Object.assign(new Error(`${body.model} is not a source model`), { kind: 'request' });
  // Right after a restart (a summary before anything loaded the list) the list is loaded first.
  if (!given && !sourceInfo(body.model)) await sourceModels().catch(() => []);
  stopped(signal);
  const info = given || sourceInfo(body.model) || { plan: 'paid' };
  // A model its app keeps for itself (OpenCode's own free ones): refused here, before a call goes out.
  if (info.unusable) throw Object.assign(new Error(info.unusable), { kind: 'free' });
  const out = await APPS[s.source].stream(body, signal, onText, onThink, { info, idleMs });
  out.usage = { ...(out.usage || {}), ...(Object.keys(out.usage || {}).length ? priced(info, out.usage) : {}) };
  out.source = s.source;
  return out;
}
/**
 * What a call cost: the figure the app reports when it sends one, else its tokens at the catalogue's prices (context
 * tiers too). A plan model (OpenCode Go, a Claude subscription) costs nothing per call; plan_cost is what it counted
 * against the plan's limits, at list price: the app's own figure when it gives one.
 */
export function priced(info, u = {}) {
  const said = u.cost !== null && u.cost !== '' && u.cost !== undefined && Number.isFinite(Number(u.cost)) ? Number(u.cost) : null;
  if (info?.plan === 'plan') return { cost: said ?? 0, plan_cost: Number(u.plan_cost) > 0 ? Number(u.plan_cost) : costOf(info, u) };
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
  const models = catalogue?.list || [];
  return Promise.all(SOURCE_IDS.map(async (id) => {
    const def = SOURCES[id], h = health.get(id);
    // The app's version: looked up when Settings shows this page, else whatever was found last.
    const v = !def.app ? null : versions ? await appVersion(def.app) : apps.get(def.app)?.v ?? null;
    const k = keyFor(id);
    return {
      id, name: def.name, short: def.short, app: def.app, billing: def.billing, site: def.site, keyUrl: def.keyUrl, docs: def.docs, keyHint: def.keyHint,
      on: !!s[id]?.on && ready(id), local: !def.needsKey, installed: ready(id), server: APPS[id].server(), install: def.install, appName: def.appName,
      ...(def.needsKey ? { needsKey: true, key: k ? { masked: mask(k.key), from: k.from, added: s[id]?.added || 0 } : null } : {}),
      app_: v ? { installed: true, version: v.version } : { installed: false },
      models: models.filter((m) => m.source === id).length, catalogueError: catalogue?.errors?.[id] || null,
      last: h ? { ok: !!h.ok, at: h.at, kind: h.kind || null, why: h.why || null, until: h.until || 0, model: h.model || null, scoped: !!h.scoped } : null,
    };
  }));
}
/** Checks a connection: starting the app and listing its models costs nothing. */
export async function testSource(id) {
  known(id);
  if (SOURCES[id].retired) return { ok: false, kind: 'request', error: SOURCES[id].retired };
  const t = Date.now();
  try {
    await APPS[id].check();
    const list = await LISTERS[id]();
    noteSourceResult(id, null, null);
    // A passing test means it works again: models set aside after a failure are tried at once.
    dropModels(id);
    return { ok: true, how: SOURCES[id].needsKey ? 'api' : 'local', ms: Date.now() - t, cost: 0, models: list.length, providers: [...new Set(list.map((m) => m.providerName).filter(Boolean))] };
  } catch (e) { noteSourceResult(id, null, e); return { ok: false, kind: failureKind(e), error: String(e.message || e).slice(0, 300) }; }
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
  stopped(signal);
  if (checkOn) body = { ...body, model: movedModel(body.model) };
  const src = sourceOf(body.model).source;
  const skip = (checkOn && sourceOffWhy(src)) || sourceSkip(src, body.model);
  let why = skip;
  if (!skip) {
    try {
      const r = await stream(body, signal || new AbortController().signal);
      noteSourceResult(src, body.model, null);
      return { message: { role: 'assistant', content: r.text, ...(r.toolCalls.length ? { tool_calls: r.toolCalls } : {}) }, usage: r.usage, ms: r.ms, model: body.model };
    } catch (e) {
      if (signal?.aborted) throw e;
      noteSourceResult(src, body.model, e);
      why = `${SOURCES[src].name} ${kindWords(failureKind(e))}: ${String(e.message || e).slice(0, 160)}`;
    }
  }
  const fb = await fallback?.(body.model);
  if (!fb) throw Object.assign(new Error(why), { status: 400 });
  const r = await orChat({ ...body, model: fb, messages: stripPass(body.messages) }, signal);
  return { ...r, model: fb, fellBack: true, why };
}
