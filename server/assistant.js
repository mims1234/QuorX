// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// ✦ The QuorX assistant: someone to talk to about QuorX itself. It answers in plain, friendly words, looks at QuorX's
// state (projects, spend, providers, settings), opens the right place in the page, proposes setting changes, and hands
// changes to QuorX's own code to the full agent, in a git worktree of its own, so the copy that runs is never touched.
//
//   - Talking runs on a cheap model, picked for value: a plan the user already pays for (marginal cost $0), else the
//     cheapest OpenRouter model that follows instructions. Both models are the user's to change.
//   - It has its own monthly budget. Every call it makes counts against it; at the limit it stops and says so.
//   - Reads and page navigation happen at once. Every change (a setting, its budget, its models, a code change to
//     QuorX) comes back as a card, and only the user's click makes it.
//   - The protocol is plain JSON in the reply text, so any model works: OpenRouter, a plan's API, or an app on this PC.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { HOME, ROOT, currentKey, chat as orChat, runtime, chatModels, speechModels } from './openrouter.js';
import { readAloudPiece, READ_ALOUD_MAX } from './readaloud.js';
import { SOURCES, SOURCE_IDS, sourceOn, sourceOffWhy, sourceModels, chatAny, keyFor } from './sources.js';
import { listProjects, saveProject, costSummary, chatPage } from './store.js';
import { SETTINGS, SETTINGS_BY_KEY, CATS, pageValue, show, checkValue, SECRET_KEY } from './quorxsettings.js';
import { appKey } from './access.js';
import { renameSoon } from './fsretry.js';

const FILE = path.join(HOME, 'data', 'assistant.json');
const VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch { return '?'; } })();
export const DEFAULT_MONTHLY = 2; // dollars a month, until the user sets another
const HISTORY_MAX = 24, STEPS_MAX = 4;
const clip = (s, n) => (String(s ?? '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s ?? ''));
const month = (t = Date.now()) => new Date(t).toISOString().slice(0, 7);

// ---------- its state: models, budget, spend per month, the conversation ----------
let state = null;
export function load() {
  if (state) return state;
  try { state = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { state = {}; }
  state.monthly ??= DEFAULT_MONTHLY;
  state.spent ??= {};
  state.history ??= [];
  return state;
}
function save() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
  renameSoon(tmp, FILE);
}
export const resetAssistant = () => { state = null; }; // tests
const spentNow = () => load().spent[month()] || 0;
const budgetLeft = () => Math.max(0, load().monthly - spentNow());

// ---------- value for money: which models to use ----------
// Talking needs speed, tools-free instruction following and a natural voice; a plan's API answers fastest at $0.
const TALK_PREF = ['claude-haiku-5-5', 'deepseek-v4.1-flash', 'qwen3.8-flash', 'gpt-6-luna', 'minimax-m3.1-flash', 'mimo-v2.6-flash'];
const CODE_PREF = ['claude-opus-5-5', 'claude-sonnet-5-5', 'kimi-k2.7-code', 'glm-5.3', 'deepseek-v4-pro', 'qwen3.8-max'];
const OR_TALK = 'qwen/qwen3.7-flash';
const OR_CODE = 'deepseek/deepseek-v4.1-flash-1017';
const API_PLANS = (id) => SOURCES[id] && !SOURCES[id].local && (SOURCES[id].billing === 'plan' || SOURCES[id].billing === 'free');

/** Every model the providers that are on can call, with what one more call costs (0 on a plan) and its list price. */
async function catalogue() {
  const list = await sourceModels().catch(() => []);
  return list.filter((m) => m.kind !== 'image' && sourceOn(m.source)).map((m) => ({
    id: m.id, source: m.source, short: String(m.id).split('/').pop(), tools: !!m.tools,
    marginal: Array.isArray(m.price) ? m.price[1] || 0 : 0, list: Array.isArray(m.listPrice) ? m.listPrice : m.price || [0, 0],
    billing: m.plan || SOURCES[m.source]?.billing || 'paid', api: !SOURCES[m.source]?.local,
  }));
}
function pickFrom(models, prefs, wantApi) {
  for (const short of prefs) {
    const hit = models.find((m) => m.short === short && m.marginal === 0 && (!wantApi || m.api));
    if (hit) return hit.id;
  }
  return null;
}
/** The models it would pick now: a talk model and a model for changes to QuorX's code. */
export async function recommended(models) {
  models ||= await catalogue();
  return {
    talk: pickFrom(models, TALK_PREF, true) || (currentKey() ? OR_TALK : pickFrom(models, TALK_PREF, false)) || OR_TALK,
    code: pickFrom(models, CODE_PREF, false) || (currentKey() ? OR_CODE : null) || OR_CODE,
  };
}
// Its voice: ElevenLabs v4 Turbo reads naturally and fast (~1¢ a reply); Sarah is a warm female voice. Listening uses
// QuorX's own speech-to-text default, a cheap model that hears well. "pc" as the voice model means Windows' own voice.
export const VOICE_DEFAULT = { model: 'elevenlabs/eleven-v4-turbo', voice: 'sarah' };
export const LISTEN_DEFAULT = 'google/gemini-3.1-flash-lite';
async function models() {
  const s = load();
  const r = s.talkModel && s.codeModel ? {} : await recommended();
  return { talk: s.talkModel || r.talk, code: s.codeModel || r.code, voice: s.voiceWith === 'pc' ? 'pc' : s.voiceModel || VOICE_DEFAULT.model, voiceName: s.voice || (s.voiceModel && s.voiceModel !== VOICE_DEFAULT.model ? '' : VOICE_DEFAULT.voice), listen: s.listenModel || LISTEN_DEFAULT };
}
// ⚙ Settings → Assistant lives with the page's settings, like every setting; each request brings them, and this
// keeps a copy so its budget, voice and self-edits use them too.
const PREF_KEYS = ['talkModel', 'codeModel', 'voiceWith', 'voiceModel', 'voice', 'listenModel'];
export function syncPrefs(prefs) {
  const a = prefs?.assistant;
  if (!a || typeof a !== 'object') return;
  const s = load(); let changed = false;
  for (const k of PREF_KEYS) { const v = String(a[k] ?? '').trim() || undefined; if (s[k] !== v) { s[k] = v; changed = true; } }
  const n = Number(a.monthly);
  if (a.monthly != null && n >= 0.1 && n <= 500 && s.monthly !== n) { s.monthly = n; changed = true; }
  if (changed) save();
}
// A change to one of its own settings is a card like any setting change: the page applies and saves it.
const settingCard = (key, label, from, to, value) => ({ id: crypto.randomUUID(), kind: 'setting', key, value, title: `Change ${label}`, from, to, where: CATS.assistant });

/** A reply read aloud with its AI voice; the cost counts against its budget. */
export async function assistantSpeak({ text, prefs } = {}) {
  // "Try the voice" in ⚙ Settings plays what the page shows, saved or not, without keeping it.
  const s = load(), keep = { ...s };
  if (prefs?.assistant) syncPrefs(prefs);
  const m = await models();
  if (prefs?.try) { for (const k of [...PREF_KEYS, 'monthly']) s[k] = keep[k]; save(); }
  if (m.voice === 'pc') return { pc: true };
  if (budgetLeft() <= 0) return { error: 'my budget for this month is used up', pc: true };
  const r = await readAloudPiece({ text: clip(String(text || ''), READ_ALOUD_MAX), model: m.voice, voice: m.voiceName || undefined });
  if (r.error) return { ...r, pc: true };
  s.spent[month()] = spentNow() + (r.cost || 0); save();
  return { url: r.url, cost: r.cost, voice: r.voice, model: r.model, budget: budgetInfo() };
}

// ---------- what it can look at and do ----------
function providersReport(models) {
  const rows = SOURCE_IDS.map((id) => {
    const d = SOURCES[id], on = sourceOn(id), mine = models.filter((m) => m.source === id);
    const free = mine.filter((m) => m.marginal === 0).length;
    return { id, name: d.name, billing: d.billing, on, why: on ? '' : sourceOffWhy(id) || 'off', models: mine.length, atZero: free, key: d.needsKey ? !!keyFor(id) : null };
  }).filter((r) => r.on || r.key);
  return { openrouterKey: !!currentKey(), providers: rows };
}

// Words people say for what QuorX's settings call something else.
const SAME = { image: ['picture', 'imagine'], picture: ['image'], photo: ['picture', 'image'], art: ['picture'], voice: ['speech', 'speak'], speech: ['voice'], tts: ['voice'],
  listen: ['mic', 'transcri'], mic: ['listen'], microphone: ['listen'], dictation: ['listen'], stt: ['listen'], cost: ['budget', 'money'], money: ['budget'], spend: ['budget'],
  yolo: ['approval'], strict: ['approval'], permission: ['approval'], font: ['text size'], video: ['video'], music: ['music'], song: ['music'] };
const STOP = new Set(['the', 'a', 'an', 'for', 'of', 'to', 'in', 'on', 'my', 'setting', 'settings', 'which', 'what', 'is', 'and', 'generation', 'gen', 'default', 'current', 'quorx']);
/** Settings matching any of the words (or what people call them), best matches first. */
export function settingsFind({ query = '', category = '' }, prefs = {}, defaults = {}) {
  const q = String(query).toLowerCase().split(/[^a-z0-9.]+/).filter((w) => w && !STOP.has(w));
  const forms = (w) => { const b = w.replace(/s$/, ''); return [w, b, ...(SAME[w] || []), ...(SAME[b] || [])]; };
  const score = (s) => { const hay = `${s.key} ${s.label} ${s.help || ''} ${CATS[s.cat] || ''}`.toLowerCase(); return q.reduce((n, w) => n + (forms(w).some((x) => hay.includes(x)) ? 1 : 0), 0); };
  const pool = SETTINGS.filter((s) => !SECRET_KEY.test(s.key) && (!category || s.cat === category));
  const hits = q.length ? pool.map((s) => [s, score(s)]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).map(([s]) => s) : pool;
  return hits.slice(0, 25).map((s) => ({ key: s.key, label: s.label, where: CATS[s.cat], now: show(s, pageValue(prefs, s, defaults)), type: s.type, ...(s.values ? { values: s.values.map(([k, l]) => `${k}=${l}`) } : {}), ...(s.min != null ? { min: s.min, max: s.max } : {}) }));
}

const TOOLS = {
  status: 'QuorX now: version, projects with their spend, this month\'s total spend, and your own budget. args: {}',
  providers: 'Every provider that is on or has a key: what it bills (plan = flat subscription, paid = per call, free, mixed), whether it works now, and how many of its models cost nothing more per call. Plus the models you recommend for talking and for code changes. args: {}',
  settings_find: 'Find QuorX settings and their values now. args: {"query": "words"} or {"category": one of ' + Object.keys(CATS).join(', ') + '}',
  settings_set: 'Propose a change to a QuorX setting; the user gets a card and decides. args: {"key": "...", "value": ...}',
  chats: 'List or search chats, newest first, with id, title, project, model and when. args: {"project": "name or id" (optional), "query": "words in the title or text" (optional), "limit": up to 30}',
  open: 'Open a place in QuorX for the user, at once. args: {"where": a settings category (' + Object.keys(CATS).join(', ') + ') or "chat:<id>"}',
  budget_set: 'Propose a new monthly budget for you (the assistant) in dollars; the user decides. args: {"monthly": number}',
  model_set: 'Propose another model for talking or for code changes; the user decides. args: {"role": "talk" | "code", "model": "model id"}',
  self_edit: 'Propose a change to QuorX\'s own code or look. On the user\'s click, QuorX\'s agent makes it in a new git worktree and branch (the running copy is untouched); the user tests it and merges. args: {"title": "short name", "goal": "what to change, in detail"}',
};

function systemPrompt(snapshot) {
  return `You are the QuorX assistant: a warm, plain-spoken helper built into QuorX, an AI agent harness on the user's PC. You talk like a capable colleague, short and human (one to four sentences, no headings, no lists unless asked), and you get things done.

You can look at QuorX and act on it through these tools:
${Object.entries(TOOLS).map(([k, v]) => `- ${k}: ${v}`).join('\n')}

Answer ONLY with one JSON object, no code fence:
{"say": "what you tell the user", "do": [{"tool": "name", "args": {...}}]}
- Put tools in "do" when you need facts or want to act; you will get their results and answer again. Use "do": [] when you are done.
- Never guess numbers, settings, chats or providers: look them up first. To open a chat by name, find it with chats, then open "chat:<id>". If a search finds nothing, try a simpler word before giving up.
- Changes are cards the user clicks; say you've put one up, never that it is done. Don't propose a card again that the user declined unless they ask.
- Earlier replies show what you looked at (lookedAt) and proposed; trust them.
- Money: prefer what the user already pays for (plans cost nothing more per call). Mention costs in dollars.
- API keys are never yours to read or set: point to ⚙ Settings → Providers.
- For changes to QuorX's own code, use self_edit with a precise goal; it runs as a normal QuorX chat the user can watch.

Right now: ${snapshot}`;
}

function snapshot(prefs) {
  const s = load();
  const projects = listProjects().length;
  return `QuorX ${VERSION}; ${projects} project(s); your talk model ${s.talkModel || '(auto)'}; your budget $${s.monthly.toFixed(2)}/month, spent $${spentNow().toFixed(4)} this month; approval mode for new chats: ${prefs?.approval || 'strict'}.`;
}

async function runTool(name, args, ctx) {
  const { prefs, defaults } = ctx;
  if (name === 'status') {
    const c = costSummary({ per: 3 });
    return { version: VERSION, monthSpendAllChats: c.total?.cost, todaySpend: c.total?.today, chats: c.total?.chats,
      projects: listProjects().slice(0, 30).map((p) => ({ id: p.id, name: p.name, missing: !!p.missing })),
      assistant: { monthly: load().monthly, spent: spentNow(), left: budgetLeft() } };
  }
  if (name === 'providers') {
    const m = await catalogue();
    return { ...providersReport(m), recommended: await recommended(m), current: await models() };
  }
  if (name === 'settings_find') {
    const hits = settingsFind(args || {}, prefs, defaults);
    return hits.length ? hits : { none: true, hint: 'no match: try one plain word (image, voice, budget, model) or a category', categories: Object.keys(CATS) };
  }
  if (name === 'chats') {
    const ref = String(args?.project || '').trim().toLowerCase(), all = listProjects();
    const p = ref ? all.find((x) => x.id.toLowerCase() === ref) || all.find((x) => x.name.toLowerCase() === ref) || all.find((x) => x.name.toLowerCase().includes(ref)) : null;
    if (ref && !p) return { error: `no project "${args.project}"`, projects: all.map((x) => x.name) };
    const page = chatPage({ project: p?.id || '', q: args?.query || '', limit: Math.min(30, Number(args?.limit) || 15) });
    const names = Object.fromEntries(all.map((x) => [x.id, x.name]));
    return { project: p?.name || 'all', total: page.total, chats: page.chats.map((c) => ({ id: c.id, title: c.title, project: names[c.projectId || 'scratch'] || 'Scratch', model: c.model || undefined, updated: c.updated ? new Date(c.updated).toISOString().slice(0, 16) : undefined })) };
  }
  if (name === 'settings_set') {
    const s = SETTINGS_BY_KEY.get(String(args?.key || ''));
    if (!s || SECRET_KEY.test(s.key)) return { error: `no setting "${args?.key}"; use settings_find` };
    let value; try { value = checkValue(s, args.value); } catch (e) { return { error: e.message }; }
    const from = show(s, pageValue(prefs, s, defaults)), to = show(s, value);
    if (from === to) return { note: `${s.label} is already ${to}` };
    ctx.cards.push({ id: crypto.randomUUID(), kind: 'setting', key: s.key, value, title: `Change ${s.label}`, from, to, where: CATS[s.cat] });
    return { proposed: true };
  }
  if (name === 'open') {
    const where = String(args?.where || '');
    if (!CATS[where] && !/^chat:[a-z0-9-]+$/i.test(where)) return { error: 'open a settings category or chat:<id>' };
    ctx.actions.push({ kind: 'open', where });
    return { opened: where };
  }
  if (name === 'budget_set') {
    const n = Math.round(Number(args?.monthly) * 100) / 100;
    if (!(n >= 0.1 && n <= 500)) return { error: 'a monthly budget from $0.10 to $500' };
    ctx.cards.push(settingCard('assistant.monthly', 'the assistant\'s monthly budget', `$${load().monthly.toFixed(2)}`, `$${n.toFixed(2)}`, n));
    return { proposed: true };
  }
  if (name === 'model_set') {
    const role = args?.role === 'code' ? 'code' : 'talk', id = String(args?.model || '').trim();
    if (!/^[\w.@:~-]+(\/[\w.@:~+-]+)+$/.test(id)) return { error: 'a model id like opencode-go/claude-haiku-5-5' };
    const cur = await models();
    ctx.cards.push(settingCard(role === 'code' ? 'assistant.codeModel' : 'assistant.talkModel', `the assistant's ${role === 'code' ? 'model for code changes' : 'thinking model'}`, cur[role], id, id));
    return { proposed: true };
  }
  if (name === 'self_edit') {
    const title = clip(String(args?.title || '').trim(), 60), goal = String(args?.goal || '').trim();
    if (!title || goal.length < 12) return { error: 'self_edit needs a title and a detailed goal' };
    ctx.cards.push({ id: crypto.randomUUID(), kind: 'self_edit', title: `Change QuorX: ${title}`, goal: clip(goal, 4000), from: 'the running QuorX', to: `a new branch, with ${(await models()).code}` });
    return { proposed: true };
  }
  return { error: `no tool ${name}` };
}

// The reply's JSON, from a model that may wrap it in a fence or add words around it.
export function parseReply(text) {
  const s = String(text || '').trim();
  const body = s.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] || s;
  const at = body.indexOf('{'), end = body.lastIndexOf('}');
  if (at >= 0 && end > at) {
    try {
      const j = JSON.parse(body.slice(at, end + 1));
      return { say: String(j.say ?? ''), do: Array.isArray(j.do) ? j.do.filter((d) => d && typeof d.tool === 'string').slice(0, 6) : [] };
    } catch { /* not JSON after all */ }
  }
  // A reply cut off mid-JSON (it ran out of room): keep the words it got to say.
  const cut = body.match(/"say"\s*:\s*"((?:[^"\\]|\\.)*)/);
  if (cut) { let t = cut[1]; try { t = JSON.parse(`"${t.replace(/\\$/, '')}"`); } catch { t = t.replace(/\\"/g, '"').replace(/\\n/g, '\n'); } return { say: `${t.trim()}${/"\s*[,}]/.test(body.slice(cut.index + cut[0].length, cut.index + cut[0].length + 3)) ? '' : '…'}`, do: [] }; }
  return { say: s, do: [] };
}

/** One turn: the user said `text`. Returns what to say, cards to confirm, page actions, cost and budget. */
export async function assistantTurn({ text, prefs = {}, defaults = {}, call } = {}) {
  syncPrefs(prefs);
  const s = load();
  const said = clip(String(text || '').trim(), 4000);
  if (!said) throw new Error('Say something first.');
  if (budgetLeft() <= 0) return { say: `I've used my $${s.monthly.toFixed(2)} for ${month()}. Raise my budget below, or wait for next month.`, cards: [settingCard('assistant.monthly', 'the assistant\'s monthly budget', `$${s.monthly.toFixed(2)}`, `$${(s.monthly * 2).toFixed(2)}`, Math.min(500, Math.round(s.monthly * 2 * 100) / 100))], actions: [], cost: 0, budget: budgetInfo() };
  const m = await models();
  const ctx = { prefs, defaults, cards: [], actions: [] };
  const msgs = [{ role: 'system', content: systemPrompt(snapshot(prefs)) },
    ...s.history.slice(-HISTORY_MAX).map((h) => ({ role: h.role, content: h.role === 'assistant' ? JSON.stringify({ say: h.content, do: [], ...(h.steps?.length ? { lookedAt: [...new Set(h.steps)] } : {}), ...(h.proposed?.length ? { proposed: h.proposed } : {}) }) : h.content })),
    { role: 'user', content: said }];
  let cost = 0, plan = 0, reply = { say: '', do: [] }, used = m.talk, steps = [];
  for (let step = 0; step <= STEPS_MAX; step++) {
    const r = await (call || ((b) => chatAny(b, undefined, { orChat })))({ model: m.talk, max_tokens: 1500, temperature: 0.4, messages: msgs });
    used = r.model || used;
    const c = Number(r.usage?.cost) || 0;
    cost += c;
    if (!c && r.usage) plan += ((r.usage.prompt_tokens || 0) * 0.15 + (r.usage.completion_tokens || 0) * 0.6) / 1e6; // what a flash model would have cost
    reply = parseReply(r.message?.content);
    if (!reply.do.length || step === STEPS_MAX || budgetLeft() - cost <= 0) break;
    msgs.push({ role: 'assistant', content: String(r.message?.content || '') });
    const results = [];
    for (const d of reply.do) {
      const out = await runTool(d.tool, d.args || {}, ctx).catch((e) => ({ error: e.message }));
      steps.push(d.tool);
      results.push(`${d.tool}: ${clip(JSON.stringify(out), 6000)}`);
    }
    msgs.push({ role: 'user', content: `Tool results:\n${results.join('\n')}\n\nNow answer the user (JSON as before).` });
  }
  s.spent[month()] = spentNow() + cost;
  s.history.push({ role: 'user', content: said, at: Date.now() }, { role: 'assistant', content: reply.say, at: Date.now(), proposed: ctx.cards.map((c) => c.title), steps });
  s.history = s.history.slice(-HISTORY_MAX * 2);
  save();
  return { say: reply.say || '…', cards: ctx.cards, actions: ctx.actions, steps, model: used, cost, planValue: plan, budget: budgetInfo() };
}

export function budgetInfo() { const s = load(); return { monthly: s.monthly, spent: spentNow(), left: budgetLeft(), month: month() }; }
export async function assistantState() {
  const s = load();
  return { models: await models(), auto: { talk: !s.talkModel, code: !s.codeModel }, recommended: await recommended(), budget: budgetInfo(), history: s.history.filter((h) => !h.note).slice(-40).map(({ role, content, at }) => ({ role, content, at })) };
}
/** The user answered a card: the assistant hears it on its next turn, so it doesn't propose it again. */
export function noteCard({ title = '', outcome = '', prefs } = {}) {
  syncPrefs(prefs);
  const words = outcome === 'yes' ? 'accepted' : outcome === 'no' ? 'declined' : 'could not apply';
  load().history.push({ role: 'user', content: `(On the card "${clip(title, 120)}", I ${words} it.)`, at: Date.now(), note: true });
  save();
  return { ok: true };
}
export function clearHistory() { load().history = []; save(); return { ok: true }; }

// ---------- what a confirmed card does (settings cards are applied by the page, like the agent's) ----------
export async function confirmCard(card = {}, prefs) {
  syncPrefs(prefs);
  if (card.kind === 'self_edit') return selfEdit(card);
  throw new Error('nothing to do for that card');
}

const slug = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'change';
/** A change to QuorX's own code: a new worktree beside QuorX's folder, a project on it, and a chat whose reply makes it. */
async function selfEdit(card) {
  const goal = String(card.goal || '').trim();
  if (!goal) throw new Error('no goal');
  if (!fs.existsSync(path.join(ROOT, '.git'))) throw new Error('QuorX is not a git checkout here, so it can\'t branch a copy of itself to change.');
  const stamp = Date.now().toString(36).slice(-5), name = `${slug(card.title.replace(/^Change QuorX:\s*/, ''))}-${stamp}`;
  const dir = path.join(path.dirname(ROOT), `${path.basename(ROOT)}-self-edits`, name), branch = `qx/assistant-${name}`;
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  execFileSync('git', ['-C', ROOT, '-c', 'core.hooksPath=', 'worktree', 'add', '-b', branch, dir, 'HEAD'], { stdio: 'pipe', windowsHide: true });
  const projectId = `qx-self-${stamp}`;
  saveProject({ id: projectId, path: dir });
  const { code } = await models();
  const base = `http://127.0.0.1:${runtime.port}`, H = { 'Content-Type': 'application/json', 'X-QuorX-Key': appKey };
  const chatId = `cm${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`, runId = `r${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
  const message = `${goal}\n\nYou are changing QuorX's own source code, in a git worktree on branch ${branch} (not the copy that is running). Keep the copyright line at the top of every file. Make the change, run the relevant tests with \`node scripts/run-tests.mjs <test file>\`, and commit on this branch with a clear message. Don't push or merge: the user tests it first.`;
  const setup = { model: code };
  const chat = { id: chatId, title: clip(card.title, 60), projectId, created: Date.now(), approval: 'strict', from: 'assistant',
    agent: { setup, allowed: [], artifacts: {}, messages: [{ role: 'user', content: message, at: Date.now() }, { role: 'assistant', content: '', at: Date.now(), runId, live: true, runActive: true, trace: [], approvals: {}, questions: {}, arts: [] }] } };
  const put = await fetch(`${base}/api/chats/${chatId}`, { method: 'PUT', headers: H, body: JSON.stringify(chat) }).then((r) => r.json());
  if (put?.error) throw new Error(put.error);
  const ac = new AbortController();
  const body = { runId, chatId, projectId, chatTitle: chat.title, setup, settings: { approval: 'strict', mediaEnabled: false }, allowed: [], history: [], summary: '', text: message, artifacts: {}, context: '', images: [], docs: [] };
  const r = await fetch(`${base}/api/run`, { method: 'POST', headers: H, body: JSON.stringify(body), signal: ac.signal });
  // The reply belongs to QuorX once it has started: the page follows it like any other.
  try { const rd = r.body.getReader(); const end = Date.now() + 15000; let got = ''; while (Date.now() < end && !/"t":"start"/.test(got)) { const { value, done } = await rd.read(); if (done) break; got += Buffer.from(value).toString('utf8'); } } catch { /* it goes on regardless */ }
  ac.abort();
  return { ok: true, chatId, projectId, branch, dir, model: code };
}
