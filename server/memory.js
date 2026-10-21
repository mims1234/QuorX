// Memory: a short list of facts and preferences the user approved ("I use pnpm", "prefer dark themes"), given to
// every chat in every project. It is kept small on purpose (about 300 tokens in all), so it fits the smallest
// models. The agent may propose an item with the remember tool; it is saved only when the user says yes, in YOLO
// too. Nothing that looks like a key, token or password is ever stored.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HOME } from './openrouter.js';
import { findKey } from './secrets.js';

const FILE = () => path.join(HOME, 'data', 'memory.json');
export const MEMORY_TOKENS = 300, ITEM_CHARS = 200, MAX_ITEMS = 30;
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
  fs.renameSync(FILE() + '.tmp', FILE());
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

/** Why `text` can't be added (or replace item `replacing`): '' when it can. */
export function checkMemory(text, mem, { replacing = null } = {}) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return 'it is empty';
  if (t.length > ITEM_CHARS) return `one item is at most ${ITEM_CHARS} characters`;
  const secret = looksSecret(t);
  if (secret) return `it looks like ${secret}, and memory never keeps secrets`;
  const others = mem.items.filter((x) => x.id !== replacing);
  if (others.some((x) => x.text.toLowerCase() === t.toLowerCase())) return 'it is already in memory';
  if (others.length >= MAX_ITEMS) return `memory holds at most ${MAX_ITEMS} items`;
  const total = memoryTokens([...others, { text: t }]);
  if (total > MEMORY_TOKENS) return `memory is full (${total} of ${MEMORY_TOKENS} tokens with this one); remove or shorten an item first`;
  return '';
}
const item = (text, by) => ({ id: `m${crypto.randomBytes(4).toString('hex')}`, text: String(text).replace(/\s+/g, ' ').trim(), by: by === 'agent' ? 'agent' : 'you', at: Date.now() });
export function addMemory(text, by = 'you') {
  const mem = loadMemory();
  const why = checkMemory(text, mem);
  if (why) return { error: why };
  const x = item(text, by);
  write({ ...mem, items: [...mem.items, x] });
  return { item: x };
}
/** Saves the whole list from the Settings editor (and the on/off checkbox); every item is checked again. */
export function saveMemory({ on, items } = {}) {
  const cur = loadMemory(), next = { on: on == null ? cur.on : !!on, items: [] };
  for (const x of Array.isArray(items) ? items : cur.items) {
    const old = cur.items.find((y) => y.id === x?.id);
    const why = checkMemory(x?.text, next);
    // A refused secret is never repeated back (it would show on screen and in logs).
    if (why) throw new Error(looksSecret(x?.text) ? why : `“${String(x?.text || '').slice(0, 60)}”: ${why}`);
    next.items.push(old && old.text === String(x.text).replace(/\s+/g, ' ').trim() ? old : { ...item(x.text, old?.by || 'you'), ...(old ? { id: old.id } : {}) });
  }
  return write(next);
}

// ---------- in the prompt ----------
/** The block every chat's system prompt gets (empty when memory is off or empty). `propose`: the remember tool is offered. */
export function memoryPrompt(mem, { propose = false } = {}) {
  if (!mem?.on) return '';
  const facts = mem.items.length ? `\n\n[About the user: facts and preferences they approved, for every project. Follow them unless this chat says otherwise.]\n${mem.items.map((x) => `- ${x.text}`).join('\n')}` : '';
  const rule = propose ? '\nWhen the user states a lasting preference or fact about how they work (not about this one task), you may propose it once with remember. The user approves each one. Never propose secrets, keys or passwords.' : '';
  return facts + (facts ? rule : rule ? `\n\n[Memory]${rule}` : '');
}
export const REMEMBER_TOOL = { type: 'function', function: { name: 'remember', description: 'Propose one short fact or preference about the user to remember in every future chat (for example "Uses pnpm, not npm"). The user must approve it. Never secrets.', parameters: { type: 'object', required: ['text'], properties: { text: { type: 'string', description: 'One short sentence, under 200 characters' } } } } };
