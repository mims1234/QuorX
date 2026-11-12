// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Model sources: where a chat's main model runs. OpenRouter is the default and stays behind everything else QuorX
// does (deciders, media, helpers, the reviewer, every fallback). An app on this computer can run the main model with
// the providers, plans and sign-ins the user connected there: the OpenCode app (opencodelocal.js), Claude Code
// (claudelocal.js) and Grok Build (groklocal.js). OpenCode Go and Command Code run over their APIs with the user's own
// key (opencodego.js, commandcode.js), and so do the model makers' own APIs: OpenAI, Anthropic, Google Gemini, Moonshot
// and Meta (directapi.js).
//   - OpenCode's own providers inside the OpenCode app are left out (blockedLocal): its Zen provider doesn't answer
//     calls from QuorX, and Go runs over its API. A chat still set to one is told to pick another (a Go model moves to
//     Go over the API when a Go key is in).
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
import { HOME, decisionModels, chatModels, cachedChatModels } from './openrouter.js';
import { renameSoon } from './fsretry.js';
import { findOnPath, localModels, localStream, ensureLocalServer, localServer, LOCAL_ID } from './opencodelocal.js';
import { failureKind } from './errors.js';
import { claudeModels, claudeStream, claudeAuth, claudeRunning, CLAUDE_ID } from './claudelocal.js';
import { grokModels, grokStream, grokRunning, GROK_ID } from './groklocal.js';
import { ACP_SOURCES, ACP_IDS, acpModels, acpStream, acpRunning } from './acp.js';
import { goModels, goStream, goCheck, goAccount, GO_ID } from './opencodego.js';
import { ollamaModels, ollamaStream, ensureOllama, ollamaServer, OLLAMA_ID } from './ollamalocal.js';
import { ccModels, ccStream, ccCheck, ccAccount, ccDecisionModels, ccDecisions, CC_ID } from './commandcode.js';
import { DIRECT, DIRECT_IDS, isDirect, cleanBase, directModels, directStream, directAccount, directDeciders, directDecisions, deciderReal } from './directapi.js';

const DATA = path.join(HOME, 'data');
export const SOURCE_FILE = path.join(DATA, 'sources.json');

// What QuorX knows about each source.
export const SOURCES = {
  // The OpenCode app on this computer (opencodelocal.js): every provider connected there.
  [LOCAL_ID]: {
    id: LOCAL_ID, name: 'OpenCode on this PC', short: 'This PC', app: 'opencode', billing: 'mixed', local: true,
    site: 'https://opencode.ai', keyUrl: 'https://opencode.ai/docs/providers/', docs: 'https://opencode.ai/docs/server/',
    keyHint: 'No key: QuorX uses the providers you connected in OpenCode (opencode auth login).', install: 'npm i -g opencode-ai', appName: 'OpenCode',
  },
  // OpenCode Go over its API (opencodego.js), with the key from the user's Go workspace.
  [GO_ID]: {
    id: GO_ID, name: 'OpenCode Go', short: 'Go', app: null, billing: 'plan', local: false, needsKey: true, env: 'OPENCODE_API_KEY',
    site: 'https://opencode.ai/go', keyUrl: 'https://opencode.ai/console', docs: 'https://opencode.ai/docs/go/',
    keyHint: 'An API key from the OpenCode Console workspace that has your Go subscription (opencode.ai/console → API keys).',
  },
  // Command Code over its Provider API (commandcode.js), with a key from Command Code Studio.
  [CC_ID]: {
    id: CC_ID, name: 'Command Code', short: 'Command Code', app: null, billing: 'plan', local: false, needsKey: true, env: 'CMD_API_KEY',
    site: 'https://commandcode.ai', keyUrl: 'https://commandcode.ai/studio', docs: 'https://commandcode.ai/docs/provider',
    keyHint: 'An API key from Command Code Studio. Every plan but Go has API access (GOAT, Pro, Max, Teams, Provider).',
  },
  // Claude Code on this computer (claudelocal.js): the subscription or API key it is signed in with.
  [CLAUDE_ID]: {
    id: CLAUDE_ID, name: 'Claude Code on this PC', short: 'Claude Code', app: 'claude', billing: 'mixed', local: true,
    site: 'https://claude.com/product/claude-code', keyUrl: 'https://code.claude.com/docs/en/setup', docs: 'https://code.claude.com/docs/en/headless',
    keyHint: 'No key: QuorX uses the account you signed in to Claude Code with.', install: 'npm i -g @anthropic-ai/claude-code', appName: 'Claude Code',
  },
  // Ollama on this computer (ollamalocal.js): the models pulled into it, and its cloud models once signed in.
  [OLLAMA_ID]: {
    id: OLLAMA_ID, name: 'Ollama on this PC', short: 'Ollama', app: 'ollama', billing: 'free', local: true,
    site: 'https://ollama.com', keyUrl: 'https://ollama.com/download', docs: 'https://docs.ollama.com/api/chat',
    keyHint: 'No key: QuorX uses the models you pulled into Ollama (ollama pull), and its cloud models once you sign in (ollama signin).', install: 'winget install Ollama.Ollama', appName: 'Ollama',
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
  // Subscription-login ACP CLIs on this computer (acp.js): Antigravity, Codex, Gemini CLI, Copilot, Cursor, Droid, Kimi, Qwen.
  ...ACP_SOURCES,
  // The model makers' own APIs (directapi.js), each with the user's key, billed per call at the provider's prices.
  ...Object.fromEntries(DIRECT_IDS.map((id) => {
    const d = DIRECT[id];
    return [id, { id, name: d.name, short: d.short, app: null, billing: 'paid', local: false, needsKey: true, direct: true, routable: d.or.length > 0, env: d.env[0], envs: d.env, site: d.site, keyUrl: d.keyUrl, docs: d.docs, keyHint: d.keyHint, base: d.base }];
  })),
};
// How QuorX reaches each app: its model list, one call, a check that costs nothing, and what its process is doing.
const APPS = {
  [LOCAL_ID]: { list: () => localModels(), stream: localStream, check: () => ensureLocalServer(), server: localServer },
  [CLAUDE_ID]: { list: () => claudeModels(), stream: claudeStream, check: () => claudeAuth({ refresh: true }), server: () => ({ running: claudeRunning() > 0, calls: claudeRunning(), perCall: true }) },
  // Listing Grok's models starts it and signs in, so it is the check too.
  [GROK_ID]: { list: () => grokModels(), stream: grokStream, check: async () => {}, server: () => ({ running: grokRunning() > 0, calls: grokRunning(), perCall: true }) },
  // Listing an ACP CLI's models opens a session and checks its sign-in without calling a model.
  ...Object.fromEntries(ACP_IDS.map((id) => [id, { list: () => acpModels(id), stream: (b, sg, t, th, o) => acpStream(id, b, sg, t, th, o), check: async () => {}, server: () => ({ running: acpRunning(id) > 0, calls: acpRunning(id), perCall: true }) }])),
  // Ollama's server is started when it isn't running; listing its models is the check.
  [OLLAMA_ID]: { list: () => ollamaModels(), stream: ollamaStream, check: () => ensureOllama(), server: ollamaServer },
  // Go's list is public; a call and the check need the key.
  [GO_ID]: { list: () => goModels(), stream: (b, sg, t, th, o) => goStream(b, sg, t, th, { ...o, key: keyFor(GO_ID)?.key }), check: async () => { const k = keyFor(GO_ID)?.key; if (!k) throw Object.assign(new Error('Add your OpenCode Go key first.'), { kind: 'auth' }); await goCheck(k, await goModels()); }, server: () => ({ api: true }),
    account: () => goAccount(keyFor(GO_ID)?.key) },
  // Its list is public too; a call and the check need the key. Its models name the plan the key is on (GOAT plan).
  [CC_ID]: { list: async () => { const [l, a] = await Promise.all([ccModels(), sourceAccount(CC_ID).catch(() => null)]); return a?.plan ? l.map((m) => ({ ...m, planLabel: a.plan })) : l; },
    account: () => ccAccount(keyFor(CC_ID)?.key), stream: (b, sg, t, th, o) => ccStream(b, sg, t, th, { ...o, key: keyFor(CC_ID)?.key }), check: async () => { const k = keyFor(CC_ID)?.key; if (!k) throw Object.assign(new Error('Add your Command Code key first.'), { kind: 'auth' }); await ccCheck(k, await ccModels()); }, server: () => ({ api: true }) },
  // A maker's API lists its models only with the key, so the list is the check, and costs nothing.
  ...Object.fromEntries(DIRECT_IDS.map((id) => [id, {
    list: () => directModels(id, { key: keyFor(id)?.key, base: baseFor(id) }),
    stream: (b, sg, t, th, o) => directStream(id, b, sg, t, th, { ...o, key: keyFor(id)?.key, base: baseFor(id) }),
    check: async () => { if (!keyFor(id)) throw Object.assign(new Error(`Add your ${DIRECT[id].name} key first.`), { kind: 'auth' }); },
    server: () => ({ api: true }),
    ...(DIRECT[id].credits ? { account: () => directAccount(id, { key: keyFor(id)?.key, base: baseFor(id) }) } : {}),
  }])),
};
export const SOURCE_IDS = Object.keys(SOURCES);

/** { source, model, def } for a source model id, or null for an OpenRouter one. */
export function sourceOf(id) {
  const s = String(id || '');
  const i = s.indexOf('/');
  if (i <= 0) return null;
  const head = s.slice(0, i), model = s.slice(i + 1);
  return Object.hasOwn(SOURCES, head) && model ? { source: head, model, def: SOURCES[head] } : null;
}
export const isSourceModel = (id) => !!sourceOf(id);
/** Who a call to a model goes to, by name (the Spending view's totals): the source its id names, else OpenRouter. */
export const providerOfModel = (id) => sourceOf(id)?.def.name || 'OpenRouter';
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
  for (const e of def.envs || [def.env]) if (e && process.env[e]) return { key: process.env[e], from: 'env', env: e };
  return null;
}
/** The address a maker's API is called at: the one set in ⚙ Settings, else its own. */
export const baseFor = (id) => (SOURCES[id]?.direct ? cleanBase(load()[id]?.base) || SOURCES[id].base : null);
/** For a maker's API: whether its models also take the place of the same models on OpenRouter ('direct'), or not ('openrouter'). */
export const routeOf = (id) => (SOURCES[id]?.direct && load()[id]?.route === 'direct' ? 'direct' : 'openrouter');
const mask = (k) => (k.length > 16 ? `${k.slice(0, 6)}••••••••${k.slice(-4)}` : '••••••••');
// Whether it can run at all: an app installed on this computer, or a key for an API.
const appBin = (d) => (d ? (d.apps || [d.app]).find((a) => a && findOnPath(a)) || null : null);
const ready = (id) => { const d = SOURCES[id]; return !!d && (d.needsKey ? !!keyFor(id) : !!appBin(d)); };
/** Whether a source's models show in the pickers: switched on, and its app installed (or its key in). */
export const sourceOn = (id) => !!load()[id]?.on && ready(id);
/** Why a source's models can't run now (no key, not installed, switched off), or ''. */
export function sourceOffWhy(id) {
  const d = SOURCES[id];
  if (!d) return 'no such source';
  if (d.needsKey && !keyFor(id)) return `${d.name} has no key yet (⚙ Settings → Providers)`;
  if (!d.needsKey && !appBin(d)) return `${d.name} is not installed (⚙ Settings → Providers)`;
  return sourceOn(id) ? '' : `${d.name} is switched off (⚙ Settings → Providers)`;
}
// What is kept: each source's switch, the key of one that takes a key, and a maker's API's own address and routing.
// Anything else an older version saved here goes.
const tidy = (all) => Object.fromEntries(Object.entries(all).filter(([k]) => Object.hasOwn(SOURCES, k)).map(([k, v]) => [k, { on: !!v?.on, ...(SOURCES[k].needsKey && typeof v?.key === 'string' && v.key ? { key: v.key, added: v.added || 0 } : {}),
  ...(SOURCES[k].direct && cleanBase(v?.base) ? { base: cleanBase(v.base) } : {}), ...(SOURCES[k].direct && v?.route === 'direct' ? { route: 'direct' } : {}) }]));
/**
 * A maker's API's options: `base`, the address its calls go to ('' for its own), and `route`, whether OpenRouter's ids
 * of the same models run on it ('direct') or stay on OpenRouter ('openrouter').
 */
export function setSourceOptions(id, { base, route } = {}) {
  known(id);
  const d = SOURCES[id];
  if (!d.direct) throw new Error(`${d.name} has no options to set.`);
  const s = tidy(load()), cur = { ...(s[id] || { on: false }) };
  if (base !== undefined) {
    const b = cleanBase(base);
    if (String(base || '').trim() && !b) throw new Error('That address isn’t one QuorX can call: it needs https:// (http:// only for this computer).');
    if (b && b !== d.base) cur.base = b; else delete cur.base;
  }
  if (route !== undefined) {
    if (!['direct', 'openrouter'].includes(route)) throw new Error('route is direct or openrouter');
    if (route === 'direct') cur.route = 'direct'; else delete cur.route;
  }
  s[id] = cur;
  save(s);
  if (base !== undefined) { clearHealth(id); dropCatalogue(id); }
}
export function setSourceOn(id, on) {
  known(id);
  const d = SOURCES[id];
  if (on && d.needsKey && !keyFor(id)) throw new Error(`Add your ${d.name} key first.`);
  if (on && !d.needsKey && !appBin(d)) throw new Error(`${d.appName} is not installed on this computer (${d.install}).`);
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
  if (id !== 'anthropic-api' && /^sk-ant-/.test(key)) throw new Error('That is an Anthropic key: add it under Anthropic instead.');
  const s = tidy(load());
  s[id] = { ...(s[id] || {}), on: true, key, added: Date.now() };
  save(s);
  accounts.delete(id);
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
  accounts.delete(id);
  clearHealth(id);
  dropCatalogue(id);
}
// OpenCode's own providers inside the OpenCode app, which QuorX doesn't offer there: its Zen provider answers only
// OpenCode's own app, and Go runs over its API with the user's key (opencodego.js).
const BLOCKED_LOCAL = {
  opencode: 'OpenCode’s own provider (OpenCode Zen) doesn’t answer calls from QuorX through the OpenCode app. Pick a model of another provider you connected in OpenCode, or an OpenCode Go model (⚙ Settings → Providers).',
  [GO_ID]: 'OpenCode Go models run with your Go key (⚙ Settings → Providers), not through the OpenCode app. Pick the same model under OpenCode Go.',
};
/** Why a model of the OpenCode app isn't offered (one of OpenCode's own providers), or ''. */
export function blockedLocal(id) {
  const s = sourceOf(id);
  return s?.source === LOCAL_ID ? BLOCKED_LOCAL[s.model.split('/')[0]] || '' : '';
}
/**
 * The model a chat set to a blocked model runs on now: a Go model the OpenCode app ran
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
export function appVersion(name, { refresh = false, run = execFile, env } = {}) {
  const c = apps.get(name);
  if (c && !refresh && Date.now() - c.at < 10 * 60e3) return Promise.resolve(c.v);
  return new Promise((resolve) => {
    const f = findOnPath(name);
    if (!f) { apps.set(name, { v: null, at: Date.now() }); return resolve(null); }
    // A .cmd runs through cmd.exe; /s strips the outer pair of quotes, so the quoted path keeps its own.
    const cmd = /\.(cmd|bat)$/i.test(f) ? [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${f}" --version"`]] : [f, ['--version']];
    run(cmd[0], cmd[1], { timeout: 15000, windowsHide: true, windowsVerbatimArguments: /\.(cmd|bat)$/i.test(f), ...(env ? { env: { ...process.env, ...env } } : {}) }, (err, out) => {
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
// ---------- apps on this PC: started only when the user uses them ----------
// Listing OpenCode, Claude Code or Grok Build starts the app, and Ollama may not be there at all, so opening QuorX
// never lists them: their last list is kept on disk (data/source-lists.json) and the pickers show that. An app is
// listed again when the user asks (Refresh, Test, switching it on) or right after a call to it (it is running then).
const ON_PC = new Set([LOCAL_ID, CLAUDE_ID, GROK_ID, OLLAMA_ID, ...ACP_IDS]);
const SAVED_LISTS = path.join(DATA, 'source-lists.json');
let savedLists = null;
const fromDisk = new Set(); // sources whose list this session is the saved copy
function readSaved() {
  if (savedLists) return savedLists;
  try { const j = JSON.parse(fs.readFileSync(SAVED_LISTS, 'utf8')); savedLists = j && typeof j === 'object' ? j : {}; } catch { savedLists = {}; }
  return savedLists;
}
function saveList(id, list) {
  savedLists = { ...readSaved(), [id]: { at: Date.now(), list } };
  try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(`${SAVED_LISTS}.tmp`, JSON.stringify(savedLists)); renameSoon(`${SAVED_LISTS}.tmp`, SAVED_LISTS); } catch { /* kept in memory */ }
}
// The saved lists of these sources go into the catalogue, nothing is started.
function useSaved(ids) {
  const s = readSaved(), at = { ...(catalogue?.at || {}) }, errs = { ...(catalogue?.errors || {}) }, old = catalogue?.list || [];
  for (const id of ids) {
    at[id] = s[id]?.at || 0;
    if (s[id]?.list?.length) { delete errs[id]; fromDisk.add(id); }
    else errs[id] = `${SOURCES[id].name} isn’t listed yet: QuorX starts it only when you ask. Press Test in ⚙ Settings → Providers, or Refresh in the model picker.`;
  }
  const keepIds = (catalogue?.ids || []).filter((id) => !ids.includes(id));
  catalogue = { at, ids: [...keepIds, ...ids], list: [...old.filter((m) => keepIds.includes(m.source)), ...ids.flatMap((id) => (Array.isArray(s[id]?.list) ? s[id].list : []).filter((m) => !blockedLocal(m.id)))], errors: errs };
}
let refreshing = null; // the refresh under way: { ids, p }
function refreshLists(ids, listers) {
  if (refreshing && ids.every((id) => refreshing.ids.includes(id))) return refreshing.p;
  const after = refreshing?.p || Promise.resolve();
  const job = { ids, p: after.catch(() => {}).then(async () => {
    const got = {}, errors = {};
    // Listing a source starts its app, which Settings alone never should: only one switched on is listed.
    await Promise.all(ids.filter((id) => sourceOn(id)).map((id) => Promise.resolve().then(() => (listers[id] || LISTERS[id])()).then((l) => { got[id] = l.filter((m) => !blockedLocal(m.id)); }, (e) => { errors[id] = e.message; })));
    const now = Date.now(), at = { ...(catalogue?.at || {}) }, errs = { ...(catalogue?.errors || {}) }, old = catalogue?.list || [];
    for (const id of ids) {
      at[id] = now;
      if (!sourceOn(id)) { delete errs[id]; got[id] = []; continue; }
      if (got[id]?.length) { delete errs[id]; fromDisk.delete(id); if (ON_PC.has(id)) saveList(id, got[id]); continue; }
      // A list that failed, or came back empty, keeps its last good copy.
      errs[id] = errors[id] || `${SOURCES[id].name} listed no models QuorX can use`;
      got[id] = old.filter((m) => m.source === id);
    }
    const keepIds = (catalogue?.ids || []).filter((id) => !ids.includes(id));
    catalogue = { at, ids: [...keepIds, ...ids], list: [...old.filter((m) => keepIds.includes(m.source)), ...ids.flatMap((id) => got[id] || [])], errors: errs };
    // Reference prices from OpenRouter's list: at once from the copy already fetched, else once it arrives (tests
    // that bring their own lists bring no OpenRouter list either).
    if (cachedChatModels()) reprice();
    else if (!Object.keys(listers).length) chatModels().then(reprice, () => {});
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
// An app on this PC is never listed here unless `refresh` or `listNow` names it (see ON_PC above).
// `forModel`: a chat is about to use this model, so its app is listed now when there is no saved list of it yet.
export async function sourceModels({ refresh = false, all = false, listers = {}, listNow = [], forModel = null } = {}) {
  const fm = forModel ? sourceOf(forModel)?.source : null;
  if (fm && ON_PC.has(fm) && !catalogue?.list.some((m) => m.id === forModel) && !readSaved()[fm]?.list?.some((m) => m.id === forModel)) listNow = [...listNow, fm];
  const want = SOURCE_IDS.filter((id) => all || sourceOn(id));
  if (!want.length) return [];
  const now = Date.now();
  const lazy = (id) => ON_PC.has(id) && !listNow.includes(id);
  const missing = want.filter((id) => !catalogue?.ids.includes(id) || listNow.includes(id));
  const stale = want.filter((id) => !missing.includes(id) && !lazy(id) && now - (catalogue.at?.[id] || 0) > (catalogue.errors?.[id] ? 60e3 : 3600e3));
  if (refresh) await refreshLists(want, listers);
  else {
    if (missing.some(lazy)) useSaved(missing.filter(lazy));
    if (missing.some((id) => !lazy(id))) await refreshLists(missing.filter((id) => !lazy(id)), listers);
    if (stale.length) refreshLists(stale, listers).catch(() => {});
  }
  // OpenRouter's list may have arrived since the catalogue was priced (the first listing doesn't wait for it).
  if (!Object.keys(listers).length) reprice();
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

// ---------- reference prices ----------
// Every call counts toward the chat's budget at a price. When a source gives no money figure of its own, the same
// model's price on OpenRouter (its list price, no discount) stands in:
//   - plan models (OpenCode Go, Command Code, Ollama cloud, a Claude or Grok subscription): what a call counted against
//     the plan. Claude Code and Grok Build price each call themselves, and their figure comes first; Go and Command
//     Code are counted at OpenRouter's price, then models.dev's list price when OpenRouter has no such model.
//   - a maker's API model models.dev has no price for (and Refuseless, which lists none): billed per call, so counted
//     at OpenRouter's price for the same model, marked as such.
//   - a model in OpenCode with no price from a subscription connected there (Copilot, a coding plan): a plan.
//   - Claude Code or Grok Build on an API key: their own figure, and OpenRouter's price for a call cut off before it.
// Free means free: a model on this computer, a free API or tier (NVIDIA's, a -free variant).
// A model OpenRouter doesn't have keeps what it had: unknown stays unknown ($0, marked), never a guess.
// A $0 model in OpenCode is free (a local model, NVIDIA's free API, a router's free tier) unless its provider is a
// subscription: those are plans, priced like any other.
const SUB_PROVIDER = /^(github-copilot|zai-coding-plan|zhipuai-coding-plan|kimi-for-coding|minimax-coding-plan|alibaba-coding-plan|moonshotai-coding|chutes-plan)/i;
const ORIG = new WeakMap(); // repriced entry → the entry as its source listed it (so pricing again starts over)
const refCost = (x) => ({ input: x.price[0], output: x.price[1], ...(x.cachePrice?.[0] != null ? { cache_read: x.cachePrice[0] } : {}), ...(x.cachePrice?.[1] != null ? { cache_write: x.cachePrice[1] } : {}) });
const sanePair = (p) => Array.isArray(p) && p.length >= 2 && p.slice(0, 2).every((v) => Number.isFinite(Number(v)) && v >= 0 && v <= 500) && (p[0] > 0 || p[1] > 0);
/** The same model in OpenRouter's chat list, for its price (null when there is none). */
export function orTwin(m, orList = []) {
  const chat = orList.filter((x) => x?.id && (!x.kind || x.kind === 'chat') && !/:(free|batch)$/.test(x.id));
  const byId = new Map(chat.map((x) => [x.id, x]));
  const name = String(m.modelID || m.realId || '').toLowerCase();
  // Claude Code names its models by family (opus, sonnet): the newest of that family on OpenRouter.
  if (m.source === CLAUDE_ID && /^[a-z]+$/.test(name)) return chat.filter((x) => x.id.startsWith(`anthropic/claude-${name}`)).sort((a, b) => (b.created || 0) - (a.created || 0))[0] || null;
  // Grok Build's ids carry suffixes OpenRouter's don't (grok-4.7-fast-reasoning is x-ai/grok-4.7-fast).
  if (m.providerID === 'x-ai' && name) { const parts = name.split('-'); for (let n = parts.length; n >= 2; n--) { const x = byId.get(`x-ai/${parts.slice(0, n).join('-')}`); if (x) return x; } }
  const hit = sameOnOpenRouter(m.id, chat.map((x) => ({ ...x, tools: true })), m);
  if (hit) return byId.get(hit) || null;
  // Names with a size tag, a variant or a date on the end: gpt-oss:120b-cloud (Ollama), glm-5.3-abliterated
  // (Refuseless), claude-haiku-4-5-20251001 (Command Code).
  const bare = name.split('/').pop().replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, '').replace(/-(abliterated|fast|cloud)$/i, '');
  const sized = bare.replace(/:(\d+(?:\.\d+)?[bkmt])(?:-cloud)?$/i, '-$1').replace(/:.*$/, ''), plain = bare.replace(/:.*$/, '');
  for (const want of [...new Set([sized, plain])]) {
    const hits = chat.filter((x) => norm(x.id.split('/').pop()) === norm(want));
    if (hits.length) return hits.find((x) => x.id.split('/')[0] === (VENDOR[m.maker] || m.maker)) || hits[0];
  }
  return null;
}
/** Source models with their reference prices (see above), from OpenRouter's chat list. */
export function withRefPrices(list = [], orList = []) {
  return list.map((m) => {
    const b = ORIG.get(m) || m;
    const out = repriced(b, orList);
    if (out !== b) ORIG.set(out, b);
    return out;
  });
}
function repriced(b, orList) {
  if (!b?.source || b.kind !== 'chat' || b.unusable) return b;
  // A -free variant on a maker's API (Refuseless's): free, not unknown.
  if (b.priceUnknown && /-free$/i.test(String(b.realId || ''))) { const { priceUnknown: _u, ...rest } = b; return { ...rest, plan: 'free', price: [0, 0], cost: {} }; }
  if (b.plan === 'free' && !(b.source === LOCAL_ID && SUB_PROVIDER.test(String(b.providerID || '')) && !/-free$/i.test(String(b.realId || '')))) return b;
  if (!(b.plan === 'plan' || b.plan === 'free' || b.priceUnknown || b.priceFromApp)) return b;
  const x = orTwin(b, orList);
  if (!x || !sanePair(x.price)) return b;
  const ref = { model: x.id, cost: refCost(x) }, list = [x.price[0], x.price[1]];
  if (b.plan === 'plan') return { ...b, ref, listPrice: list, refFrom: x.id };
  // No price in OpenCode, not a local model: a subscription connected there.
  if (b.plan === 'free') return { ...b, plan: 'plan', planLabel: b.providerName || b.providerID || 'OpenCode', ref, listPrice: list, refFrom: x.id };
  if (b.priceFromApp) return { ...b, ref, refFrom: x.id };
  const { priceUnknown: _u, ...rest } = b;
  return { ...rest, price: list, cost: ref.cost, priceRef: x.id, refFrom: x.id };
}
/** Prices the loaded catalogue again with OpenRouter's list as last fetched. */
// Only when that list is newer than the one the catalogue was priced with (cheap to call often).
export function reprice() {
  const or = cachedChatModels();
  if (catalogue && or?.length && catalogue.pricedWith !== or) catalogue = { ...catalogue, list: withRefPrices(catalogue.list, or), pricedWith: or };
}

// ---------- OpenRouter's ids on a maker's own API (⚙ Settings → Providers → "OpenRouter's ids run here") ----------
const ROUTE_VENDOR = Object.fromEntries(DIRECT_IDS.flatMap((id) => DIRECT[id].or.map((v) => [v, id])));
/** The maker's API an OpenRouter id would run on when routed there (on and set to take OpenRouter's ids), or null. */
export function routeSource(id) {
  const s = String(id || ''), i = s.indexOf('/');
  if (i <= 0 || sourceOf(s) || s.includes(':')) return null;
  const src = ROUTE_VENDOR[s.slice(0, i)];
  return src && routeOf(src) === 'direct' && sourceOn(src) ? src : null;
}
/** The same model in a maker's API list (claude-sonnet-4.5 on OpenRouter is claude-sonnet-4-5 there), or null. */
export function sameOnDirect(id, src, list = catalogue?.list || []) {
  const want = norm(String(id).split('/').slice(1).join('/'));
  const hits = list.filter((m) => m.source === src && m.kind === 'chat' && m.status !== 'deprecated' && norm(m.realId) === want);
  return (hits.find((m) => !/-\d{8}$/.test(m.realId)) || hits[0])?.id || null;
}
/**
 * The model a call for `id` runs on: an OpenRouter id goes to the same model on its maker's own API when the user
 * chose that, and that API has it; any other id stays as it is. Loads the model lists when none are loaded yet.
 */
export async function routeModel(id) {
  const src = routeSource(id);
  if (!src) return id;
  if (!catalogue?.ids.includes(src)) await sourceModels().catch(() => []);
  return sameOnDirect(id, src) || id;
}

// ---------- health: what failed lately ----------
const health = new Map(); // source → { ok, at, kind, why, until, model, scoped, fails }: its last result
const modelHealth = new Map(); // `${source}|${model}` → the same, for failures that only one model had
const dropModels = (id) => { for (const k of [...modelHealth.keys()]) if (k.startsWith(`${id}|`)) modelHealth.delete(k); };
const clearHealth = (id) => { health.delete(id); dropModels(id); };
// Tests start each case clean.
export const forgetSourceHealth = (id) => (id ? clearHealth(id) : (health.clear(), modelHealth.clear()));
// How a failed call failed lives in errors.js, shared with the agent loop.
export { failureKind };
const KIND_WORDS = { notinstalled: 'is not installed on this computer', free: 'keeps that free model for its own app right now', auth: 'refused its key', quota: 'is out of credit or plan usage', rate: 'is rate limiting', model: 'does not have that model now', server: 'had a server error', network: 'could not be reached', timeout: 'did not answer in time', shape: 'answered in a shape QuorX can\'t read', request: 'refused the request', setting: 'refused it because of a setting in your account there', unknown: 'failed' };
export const kindWords = (k) => KIND_WORDS[k] || KIND_WORDS.unknown;
// Each model of an app runs on its own provider, so a refused key, a spent plan or an outage is that model's: it is
// set aside and the rest keep working. Only the app itself missing or unreachable is the whole source's.
const SOURCE_KINDS = new Set(['notinstalled', 'network']);
export function noteSourceResult(id, model, err, { now = Date.now() } = {}) {
  if (!err) { health.set(id, { ok: true, at: now, model, fails: 0 }); if (model) modelHealth.delete(`${id}|${model}`); return; }
  // A maker's API has one key and one account for all its models: a refused key or spent credit is the whole source's.
  const kind = failureKind(err), scoped = !SOURCE_KINDS.has(kind) && !(SOURCES[id]?.direct && (kind === 'auth' || kind === 'quota'));
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
  // When a usage limit really resets (Retry-After, uncapped): the switch card shows it, while skipping stops at `until`.
  const asked = Math.max(0, Number(err?.retryAfter) || 0) * 1000, reset = ['quota', 'rate', 'free'].includes(kind) && asked && asked <= 7 * 24 * 3600e3 ? now + asked : 0;
  const rec = { ok: false, at: now, kind, why: String(err?.message || kind).slice(0, 300), until: wait && key ? now + wait : 0, model: scoped ? model || null : null, scoped, fails, ...(reset ? { reset } : {}) };
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

/**
 * The usage limit a source (or one of its models) is waiting out now: { kind, why, reset } (reset: when it resets, ms,
 * or 0 when it didn't say), or null. A limit that is skipping calls now is what the model-switch card is about.
 */
export function sourceLimit(id, model, now = Date.now()) {
  const lim = (h) => (h && !h.ok && h.until && now < h.until && ['quota', 'rate', 'free'].includes(h.kind) ? { kind: h.kind, why: h.why, reset: h.reset > now ? h.reset : h.until } : null);
  const h = health.get(id);
  return (h && !h.scoped ? lim(h) : null) || (model ? lim(modelHealth.get(`${id}|${model}`)) : null);
}

// ---------- decision models (Command Code's Jev) ----------
/**
 * The decision models of the sources that are on: Jev on Command Code, priced at its list price on OpenRouter, and the
 * chat models of the makers' APIs, asked in plain words (directapi.js).
 */
export async function sourceDecisionModels() {
  const direct = DIRECT_IDS.some((id) => sourceOn(id)) ? directDeciders((await sourceModels().catch(() => [])).filter((m) => SOURCES[m.source]?.direct)) : [];
  return [...(sourceOn(CC_ID) ? ccDecisionModels(await decisionModels().catch(() => [])) : []), ...direct];
}
/**
 * One Decisions request through a source (a decider on commandcode/typesafe/jev), answered like openrouter.js
 * decisions(). On a plan it costs nothing per call; usage.plan_cost is what it took from the credits, at list price.
 */
export async function sourceDecisions(model, state, questions, signal) {
  stopped(signal);
  const s = sourceOf(model);
  if (s && SOURCES[s.source].direct && deciderReal(model)) return directDecide(s.source, model, state, questions, signal);
  if (s?.source !== CC_ID) throw Object.assign(new Error(`${model} is not a decision model QuorX can reach`), { kind: 'request' });
  const why = sourceOffWhy(CC_ID) || sourceSkip(CC_ID, model);
  if (why) throw Object.assign(new Error(why), { kind: 'request' });
  const info = (await sourceDecisionModels()).find((m) => m.id === model) || { plan: 'plan' };
  try {
    const r = await ccDecisions(model, state, questions, signal, { key: keyFor(CC_ID)?.key });
    noteSourceResult(CC_ID, model, null);
    r.usage = { ...r.usage, ...priced(info, r.usage) };
    return r;
  } catch (e) { if (!signal?.aborted) noteSourceResult(CC_ID, model, e); throw e; }
}

// A decider on a maker's API: its chat model asked the questions, the call priced like any other.
async function directDecide(src, model, state, questions, signal) {
  const chatId = `${src}/${deciderReal(model)}`;
  const why = sourceOffWhy(src) || sourceSkip(src, chatId);
  if (why) throw Object.assign(new Error(why), { kind: 'request' });
  const info = (await sourceModels().catch(() => [])).find((m) => m.id === chatId);
  if (!info) throw Object.assign(new Error(`${SOURCES[src].name} doesn’t list ${deciderReal(model)} now`), { kind: 'model' });
  try {
    const r = await directDecisions({ ...info, chatId }, state, questions, signal, { stream: (b, sg) => APPS[src].stream(b, sg, null, null, { info, idleMs: 60e3 }) });
    noteSourceResult(src, chatId, null);
    r.usage = { ...r.usage, ...priced(info, r.usage) };
    return r;
  } catch (e) { if (!signal?.aborted) noteSourceResult(src, chatId, e); throw e; }
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
// onCall(index, call) hears each tool call as it streams in, from every source that can tell (the page's preparing row).
export async function sourceStream(body, signal, onText, onThink, { info: given, idleMs = 180e3, onCall } = {}) {
  stopped(signal);
  const s = sourceOf(body.model);
  if (!s) throw Object.assign(new Error(`${body.model} is not a source model`), { kind: 'request' });
  // Right after a restart (a summary before anything loaded the list) the list is loaded first.
  if (!given && !sourceInfo(body.model)) await sourceModels({ forModel: body.model }).catch(() => []);
  stopped(signal);
  const info = given || sourceInfo(body.model) || { plan: 'paid' };
  // A model its app keeps for itself (OpenCode's own free ones): refused here, before a call goes out.
  if (info.unusable) throw Object.assign(new Error(info.unusable), { kind: 'free' });
  const out = await APPS[s.source].stream(body, signal, onText, onThink, { info, idleMs, ...(onCall ? { onCall } : {}) });
  out.usage = { ...(out.usage || {}), ...(Object.keys(out.usage || {}).length ? priced(info, out.usage) : {}) };
  out.source = s.source;
  // The app answered, so it is running: its list (the saved copy until now) is brought up to date in the background.
  if (fromDisk.has(s.source)) { fromDisk.delete(s.source); refreshLists([s.source], {}).catch(() => {}); }
  return out;
}
/**
 * What a call cost: the figure the app reports when it sends one, else its tokens at the catalogue's prices (context
 * tiers too). A plan model (OpenCode Go, a Claude subscription) costs nothing per call; plan_cost is what it counted
 * against the plan's limits, at list price: the app's own figure when it gives one.
 */
// No single call costs more than this: a figure above it (a bad price record, a misread report) counts as unknown, 0.
export const CALL_COST_MAX = 50;
const saneCall = (x) => Number.isFinite(x) && x >= 0 && x <= CALL_COST_MAX;
// Where a call's figure came from, for the page: plan_ref / cost_ref 'app' (the app's own), 'openrouter' (the same
// model's price there, ref_model naming it) or 'list' (models.dev's list price).
export function priced(info, u = {}) {
  const said = u.cost !== null && u.cost !== '' && u.cost !== undefined && Number.isFinite(Number(u.cost)) ? Number(u.cost) : null;
  const ref = info?.ref?.cost ? info.ref : null;
  const atRef = () => costOf({ cost: ref.cost }, u);
  if (info?.plan === 'plan') {
    // Claude Code and Grok Build price each call themselves; the plans with an API (Go, Command Code) are counted at
    // OpenRouter's price, not the app's or a discounted one.
    const app = Number(u.plan_cost) > 0 && saneCall(Number(u.plan_cost)) ? Number(u.plan_cost) : null;
    const appFirst = info.source === CLAUDE_ID || info.source === GROK_ID;
    const from = appFirst && app != null ? 'app' : ref ? 'openrouter' : app != null ? 'app' : 'list';
    const v = from === 'app' ? app : from === 'openrouter' ? atRef() : costOf(info, u);
    return { cost: said != null && saneCall(said) ? said : 0, plan_cost: saneCall(v) ? v : 0, plan_ref: from, ...(from === 'openrouter' ? { ref_model: ref.model } : {}) };
  }
  if (said != null) return saneCall(said) ? { cost: said } : { cost: 0, cost_unknown: true };
  if (info?.plan === 'free') return { cost: 0 };
  // Claude Code or Grok Build on an API key that sent no figure: OpenRouter's price for the same model.
  if (info?.priceFromApp && ref) { const c = atRef(); return saneCall(c) ? { cost: c, estimated_cost: true, cost_ref: 'openrouter', ref_model: ref.model } : { cost: 0, estimated_cost: true, cost_unknown: true }; }
  // A model whose price isn't known costs 0 here, marked unknown, rather than a guess.
  if (info?.priceUnknown) return { cost: 0, estimated_cost: true, cost_unknown: true };
  const c = costOf(info, u);
  return saneCall(c) ? { cost: c, estimated_cost: true, ...(info?.priceRef ? { cost_ref: 'openrouter', ref_model: info.priceRef } : {}) } : { cost: 0, estimated_cost: true, cost_unknown: true };
}
function costOf(info, u) {
  const c = info?.cost || {}, prompt = Number(u.prompt_tokens) || 0, out = Number(u.completion_tokens) || 0;
  const read = Number(u.prompt_tokens_details?.cached_tokens ?? u.cache_read_input_tokens) || 0, write = Number(u.prompt_tokens_details?.cache_write_tokens ?? u.cache_creation_input_tokens) || 0;
  const tier = (Array.isArray(c.tiers) ? c.tiers : []).filter((x) => prompt > Number(x?.tier?.size || Infinity)).sort((a, b) => b.tier.size - a.tier.size)[0] || c;
  const p = (k) => per(tier[k] ?? c[k]);
  const fresh = Math.max(0, prompt - read - write);
  return (fresh * p('input') + read * (tier.cache_read != null || c.cache_read != null ? p('cache_read') : p('input')) + write * (tier.cache_write != null || c.cache_write != null ? p('cache_write') : p('input')) + out * p('output')) / 1e6;
}

// ---------- a subscription's plan and what is left of it (OpenCode Go, Command Code), or a key's balance (Refuseless) ----------
const accounts = new Map(); // source → { at, p }: the last look-up, kept a minute
/** The plan a source's key is on and what is left of it; `refresh` asks again at once. Throws for a source without one. */
export function sourceAccount(id, { refresh = false } = {}) {
  known(id);
  if (!APPS[id].account) throw Object.assign(new Error(`${SOURCES[id].name} doesn’t report its plan`), { status: 404 });
  const c = accounts.get(id);
  if (c && !refresh && Date.now() - c.at < 60e3) return c.p;
  const p = APPS[id].account();
  accounts.set(id, { at: Date.now(), p });
  p.catch(() => accounts.delete(id));
  return p;
}

// ---------- what Settings shows ----------
export async function sourceStatus({ versions = true } = {}) {
  const s = load();
  const models = catalogue?.list || [];
  return Promise.all(SOURCE_IDS.map(async (id) => {
    const def = SOURCES[id], h = health.get(id);
    // The app's version: looked up when Settings shows this page, else whatever was found last.
    const bin = !def.app ? null : appBin(def) || def.app;
    const v = !bin ? null : versions ? await appVersion(bin, { env: def.envVars }) : apps.get(bin)?.v ?? null;
    const k = keyFor(id);
    return {
      id, name: def.name, short: def.short, app: def.app, billing: def.billing, site: def.site, keyUrl: def.keyUrl, docs: def.docs, keyHint: def.keyHint,
      on: !!s[id]?.on && ready(id), local: !def.needsKey, installed: ready(id), server: APPS[id].server(), install: def.install, appName: def.appName,
      ...(APPS[id].account ? { account: true } : {}),
      ...(def.needsKey ? { needsKey: true, env: k?.env || def.env, key: k ? { masked: mask(k.key), from: k.from, added: s[id]?.added || 0 } : null } : {}),
      ...(def.direct ? { direct: true, base: baseFor(id), defaultBase: def.base, route: routeOf(id), routable: def.routable, envs: def.envs } : {}),
      app_: v ? { installed: true, version: v.version } : { installed: false },
      models: models.filter((m) => m.source === id).length, catalogueError: catalogue?.errors?.[id] || null,
      last: h ? { ok: !!h.ok, at: h.at, kind: h.kind || null, why: h.why || null, until: h.until || 0, model: h.model || null, scoped: !!h.scoped } : null,
    };
  }));
}
/** Checks a connection: starting the app and listing its models costs nothing. */
export async function testSource(id) {
  known(id);
  const t = Date.now();
  try {
    await APPS[id].check();
    const list = (await LISTERS[id]()).filter((m) => !blockedLocal(m.id));
    // The user asked: an app on this PC keeps this list, and the pickers show it from now on.
    if (ON_PC.has(id) && list.length) { saveList(id, list); fromDisk.delete(id); dropCatalogue(id); }
    noteSourceResult(id, null, null);
    // A passing test means it works again: models set aside after a failure are tried at once.
    dropModels(id);
    return { ok: true, how: SOURCES[id].needsKey ? 'api' : 'local', ms: Date.now() - t, cost: 0, models: list.length, providers: [...new Set(list.map((m) => m.providerName).filter(Boolean))], ...(SOURCES[id].direct ? { priced: list.filter((m) => !m.priceUnknown).length } : {}) };
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
  // An OpenRouter id the user runs on its maker's own API goes there (and back to OpenRouter if that fails).
  const asked = body.model;
  if (checkOn && !isSourceModel(body.model)) body = { ...body, model: await routeModel(body.model) };
  if (!isSourceModel(body.model)) { const r = await orChat({ ...body, messages: stripPass(body.messages) }, signal); return { ...r, model: body.model }; }
  stopped(signal);
  if (checkOn) body = { ...body, model: movedModel(body.model) };
  const src = sourceOf(body.model).source;
  const skip = (checkOn && (blockedLocal(body.model) || sourceOffWhy(src))) || sourceSkip(src, body.model);
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
  const fb = asked !== body.model && !isSourceModel(asked) ? asked : await fallback?.(body.model);
  if (!fb) throw Object.assign(new Error(why), { status: 400 });
  const r = await orChat({ ...body, model: fb, messages: stripPass(body.messages) }, signal);
  return { ...r, model: fb, fellBack: true, why };
}
