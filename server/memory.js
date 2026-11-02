// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Memory: a short list of facts and preferences the user approved ("I use pnpm", "prefer dark themes"), given to
// every chat in every project. It is kept small on purpose (about 300 tokens in all), so it fits the smallest
// models. The agent may propose an item with the remember tool; it is saved only when the user says yes, in YOLO
// too. Nothing that looks like a key, token or password is ever stored.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HOME } from './openrouter.js';
import { findKey } from './secrets.js';
import { renameSoon } from './fsretry.js';

const FILE = () => path.join(HOME, 'data', 'memory.json');
export const MEMORY_TOKENS = 300, ITEM_CHARS = 200, MAX_ITEMS = 60; // the token limit is per chat: every-project items plus one project's
// About 4 characters a token in English; rounded up per item, so the limit holds for any tokenizer near that.
export const tokensOf = (s) => Math.ceil(String(s || '').length / 4);
export const memoryTokens = (items) => items.reduce((n, x) => n + tokensOf(x.text) + 2, 0); // + "- " and the line break

export function loadMemory() {
  try { const j = JSON.parse(fs.readFileSync(FILE(), 'utf8')); return { on: j.on !== false, items: Array.isArray(j.items) ? j.items.filter((x) => x && typeof x.text === 'string') : [] }; }
  catch { return { on: true, items: [] }; }
}
function write(mem) {
  fs.mkdirSync(path.dirname(FILE()), { recursive: true });
  fs.writeFileSync(FILE() + '.tmp', JSON.stringify({ version: 1, on: mem.on, items: mem.items }, null, 2));
  renameSoon(FILE() + '.tmp', FILE());
  return mem;
}

// ---------- never a secret ----------
// The key patterns are shared with /review (server/secrets.js); memory also refuses secrets written as prose.
const SECRET = [
  [/\b(?:passwords?|passwd|pwd|passcode|passphrase|secret|api[\s_-]?key|access[\s_-]?key|(?:access|auth|bearer|api|refresh)[\s_-]?token|token|pin|otp|cvv|ssn)\b\s*(?:is|=|:)\s*\S{3,}/i, 'a password or key'],
  [/\b(?:\d[ -]?){13,19}\b/, 'a card or account number'],
];
// A long run of letters and digits mixed like a generated key (not a word, a path or a version).
const RANDOMISH = /(?<![\w/.-])(?=[A-Za-z0-9_+/=-]{24,}(?![\w/.-]))(?=[^\s]*[a-z])(?=[^\s]*[A-Z])(?=[^\s]*\d)[A-Za-z0-9_+/=-]{24,}/;
export function looksSecret(text) {
  const t = String(text || '');
  const key = findKey(t);
  if (key) return key;
  for (const [re, what] of SECRET) if (re.test(t)) return what;
  if (RANDOMISH.test(t)) return 'something that looks like a key';
  return '';
}

// ---------- what an item holds ----------
// type: about you (user) · how to work (feedback) · a project fact (project) · where to find something (reference).
// why: one line on the reason (it makes the rule easier to apply well). details: longer notes a chat reads only when the
// item matters (recall), so they cost nothing in every prompt. project: '' for every project, or one project's id.
export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'];
export const WHY_CHARS = 200, DETAILS_CHARS = 2000;
const flat = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const extraOf = (x = {}) => ({
  type: MEMORY_TYPES.includes(x.type) ? x.type : 'user',
  why: flat(x.why).slice(0, WHY_CHARS),
  details: String(x.details ?? '').replace(/\r\n/g, '\n').trim().slice(0, DETAILS_CHARS),
  project: /^[\w-]{1,80}$/.test(String(x.project || '')) ? String(x.project) : '',
});
// What every chat in project p gets: the items for every project and p's own. The limit is per prompt.
const loaded = (items, p) => items.filter((x) => !x.project || x.project === p);
const promptTokens = (items) => items.reduce((n, x) => n + tokensOf(x.text) + (x.why ? tokensOf(x.why) + 3 : 0) + 2, 0);
/** The most any one prompt carries with these items: every-project items plus the fullest project's. */
export function worstPromptTokens(items) {
  const ps = [...new Set(items.map((x) => x.project).filter(Boolean))];
  return Math.max(promptTokens(loaded(items, '')), ...ps.map((p) => promptTokens(loaded(items, p))));
}

/** Why `text` can't be added (or replace item `replacing`): '' when it can. `extra`: its why, details and project. */
export function checkMemory(text, mem, { replacing = null, ...extra } = {}) {
  const t = flat(text);
  if (!t) return 'it is empty';
  if (t.length > ITEM_CHARS) return `one item is at most ${ITEM_CHARS} characters`;
  const x = extraOf(extra);
  const secret = looksSecret(t) || looksSecret(x.why) || looksSecret(x.details);
  if (secret) return `it looks like ${secret}, and memory never keeps secrets`;
  const others = mem.items.filter((y) => y.id !== replacing);
  if (others.some((y) => y.text.toLowerCase() === t.toLowerCase() && (y.project || '') === x.project)) return 'it is already in memory';
  if (others.length >= MAX_ITEMS) return `memory holds at most ${MAX_ITEMS} items`;
  const total = worstPromptTokens([...others, { text: t, ...x }]);
  if (total > MEMORY_TOKENS) return `memory is full (${total} of ${MEMORY_TOKENS} tokens in a chat with this one); remove or shorten an item first, or keep the long part in its details`;
  return '';
}
const item = (text, by, extra) => ({ id: `m${crypto.randomBytes(4).toString('hex')}`, text: flat(text), ...extraOf(extra), by: by === 'agent' ? 'agent' : 'you', at: Date.now() });
export function addMemory(text, by = 'you', extra = {}) {
  const mem = loadMemory();
  const why = checkMemory(text, mem, extra);
  if (why) return { error: why };
  const x = item(text, by, extra);
  write({ ...mem, items: [...mem.items, x] });
  return { item: x };
}
/** Saves the whole list from the Settings editor (and the on/off checkbox); every item is checked again. */
export function saveMemory({ on, items } = {}) {
  const cur = loadMemory(), next = { on: on == null ? cur.on : !!on, items: [] };
  for (const x of Array.isArray(items) ? items : cur.items) {
    const old = cur.items.find((y) => y.id === x?.id);
    const extra = extraOf({ ...old, ...x });
    const why = checkMemory(x?.text, next, extra);
    // A refused secret is never repeated back (it would show on screen and in logs).
    if (why) throw new Error(looksSecret(x?.text) ? why : `“${String(x?.text || '').slice(0, 60)}”: ${why}`);
    const same = old && old.text === flat(x.text) && JSON.stringify(extraOf(old)) === JSON.stringify(extra);
    next.items.push(same ? old : { ...item(x.text, old?.by || 'you', extra), ...(old ? { id: old.id, at: old.at } : {}) });
  }
  return write(next);
}

// ---------- in the prompt ----------
/** The items a chat in project `projectId` gets. */
export const itemsFor = (mem, projectId = '') => (mem?.on ? loaded(mem.items, String(projectId || '')) : []);
const TYPE_HEAD = { user: 'About the user', feedback: 'How they want you to work', project: 'About this project', reference: 'Where to find things' };
/** The block every chat's system prompt gets (empty when memory is off or empty). `propose`: the remember tool is offered. */
export function memoryPrompt(mem, { propose = false, projectId = '' } = {}) {
  if (!mem?.on) return '';
  const list = itemsFor(mem, projectId);
  const line = (x) => `- ${x.text}${x.why ? ` (why: ${x.why})` : ''}${x.details ? ` [more: recall ${x.id}]` : ''}`;
  const groups = MEMORY_TYPES.map((t) => [t, list.filter((x) => (x.type || 'user') === t)]).filter(([, l]) => l.length);
  const facts = list.length ? `\n\n[Memory: facts and preferences the user approved. Follow them unless this chat says otherwise.${list.some((x) => x.details) ? ' An item marked "more" has longer notes: read them with recall when it matters to the task.' : ''}]\n${groups.map(([t, l]) => (groups.length > 1 || t !== 'user' ? `${TYPE_HEAD[t]}:\n` : '') + l.map(line).join('\n')).join('\n')}` : '';
  const rule = propose ? '\nWhen the user states a lasting preference or fact (how they like you to work, about them, about this project, or where something is), not about this one task, you may propose it once with remember: text one sentence under 200 characters; type user (about them), feedback (how to work), project or reference (where something is); why one short line; details only for longer notes; scope "project" when it is about this project only. The user approves each one. Never propose secrets, keys or passwords.' : '';
  return facts + (facts ? rule : rule ? `\n\n[Memory]${rule}` : '');
}
// Kept under 500 characters for small models: what each field means is in the memory rule of the prompt.
export const REMEMBER_TOOL = { type: 'function', function: { name: 'remember', description: 'Propose a short fact to remember in future chats ("Uses pnpm, not npm"). The user approves it. Never secrets.', parameters: { type: 'object', required: ['text'], properties: {
  text: { type: 'string' }, type: { type: 'string', enum: MEMORY_TYPES }, why: { type: 'string' }, details: { type: 'string' }, scope: { type: 'string', enum: ['all', 'project'] } } } } };
export const RECALL_TOOL = { type: 'function', function: { name: 'recall', description: 'Read the longer notes of a memory item marked "more" (by its id, like m1a2b3c4d).', parameters: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } } };
