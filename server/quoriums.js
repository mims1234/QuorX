// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Quoriums: a saved combo of the helper modules a chat uses (the prompt enhancer, reviewer, fresh eyes, deciders,
// helpers and the paid media tools), each on or off and each with its own model. A chat picks one Quorium and its
// main model; modules that are off never run in it. QuorX comes with a few; each can be edited (and reset), and the
// user adds their own. A model left empty means the one set in ⚙ Settings.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HOME } from './openrouter.js';
import { renameSoon } from './fsretry.js';

const FILE = () => path.join(HOME, 'data', 'quoriums.json');
export const MODULES = ['enhancer', 'reviewer', 'freshEyes', 'deciders', 'helpers', 'image', 'video', 'music', 'speech'];
export const MAX_MINE = 100, NAME_CHARS = 60, DESC_CHARS = 200;

const combo = (on) => Object.fromEntries(MODULES.map((k) => [k, { on: on.includes(k), model: '' }]));
// "Standard" is what a new chat had before Quoriums: the checks on, the prompt enhancer and paid media off.
export const BUILT_IN = [
  { id: 'standard', name: 'Standard', desc: 'QuorX\'s usual checks: reviewer, fresh eyes, deciders and helpers.', modules: combo(['reviewer', 'freshEyes', 'deciders', 'helpers']) },
  { id: 'solo', name: 'Solo', desc: 'The main model alone. Fastest and cheapest; nothing checks the work.', modules: combo([]) },
  { id: 'careful', name: 'Careful Coder', desc: 'Standard, plus the prompt enhancer spelling out what you asked for.', modules: combo(['enhancer', 'reviewer', 'freshEyes', 'deciders', 'helpers']) },
  { id: 'web', name: 'Web Builder', desc: 'Careful Coder with pictures, for sites and apps that need images.', modules: combo(['enhancer', 'reviewer', 'freshEyes', 'deciders', 'helpers', 'image']) },
  { id: 'creator', name: 'Creator', desc: 'Pictures, video, music and voice, with the deciders checking each paid call.', modules: combo(['enhancer', 'deciders', 'image', 'video', 'music', 'speech']) },
];
const BUILT_IDS = new Set(BUILT_IN.map((q) => q.id));

function read() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    return { edits: j.edits && typeof j.edits === 'object' ? j.edits : {}, mine: Array.isArray(j.mine) ? j.mine : [] };
  } catch { return { edits: {}, mine: [] }; }
}
function write(d) {
  fs.mkdirSync(path.dirname(FILE()), { recursive: true });
  fs.writeFileSync(FILE() + '.tmp', JSON.stringify({ version: 1, edits: d.edits, mine: d.mine }, null, 2));
  renameSoon(FILE() + '.tmp', FILE());
}

// A model id as QuorX writes them (openrouter "vendor/name", an app on this PC "opencode:…"), never anything else.
const MODEL_ID = /^[\w.:@+\/-]{1,200}$/;
const text = (v, n) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
export function cleanQuorium(q, { id } = {}) {
  if (!q || typeof q !== 'object') throw new Error('Not a Quorium.');
  const name = text(q.name, NAME_CHARS);
  if (!name) throw new Error('Give the Quorium a name.');
  const modules = {};
  for (const k of MODULES) {
    const m = q.modules?.[k] || {};
    const model = text(m.model, 200);
    if (model && !MODEL_ID.test(model)) throw new Error(`"${model}" is not a model id.`);
    modules[k] = { on: !!m.on, model };
  }
  return { id: id || q.id, name, desc: text(q.desc, DESC_CHARS), modules };
}

// Every Quorium, the built-in ones first (with your edits, marked edited), then yours in the order you made them.
export function listQuoriums() {
  const d = read();
  const built = BUILT_IN.map((b) => {
    let e = null;
    try { e = d.edits[b.id] ? cleanQuorium(d.edits[b.id], { id: b.id }) : null; } catch { /* a broken edit: the built-in one */ }
    return { ...(e || structuredClone(b)), builtIn: true, edited: !!e };
  });
  const mine = d.mine.flatMap((q) => { try { return [{ ...cleanQuorium(q, { id: q.id }), builtIn: false, edited: false }]; } catch { return []; } });
  return [...built, ...mine];
}

// Saves an edit of a built-in Quorium, or one of yours (a new one when it has no id yet). Returns what was saved.
export function saveQuorium(q) {
  const d = read();
  if (q?.id && BUILT_IDS.has(q.id)) {
    const c = cleanQuorium(q, { id: q.id });
    d.edits[q.id] = c; write(d);
    return { ...c, builtIn: true, edited: true };
  }
  const known = q?.id && d.mine.findIndex((x) => x.id === q.id);
  if (q?.id && known === -1 && !/^q[a-z0-9]{6,20}$/.test(q.id)) throw new Error('Unknown Quorium.');
  const c = cleanQuorium(q, { id: q?.id || `q${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}` });
  if (known >= 0) d.mine[known] = c;
  else { if (d.mine.length >= MAX_MINE) throw new Error(`You have ${MAX_MINE} Quoriums; delete one first.`); d.mine.push(c); }
  write(d);
  return { ...c, builtIn: false, edited: false };
}

// Yours: deleted. A built-in one: back to how QuorX ships it.
export function removeQuorium(id) {
  const d = read();
  if (BUILT_IDS.has(id)) { if (!d.edits[id]) return false; delete d.edits[id]; write(d); return true; }
  const n = d.mine.length;
  d.mine = d.mine.filter((x) => x.id !== id);
  if (d.mine.length === n) return false;
  write(d);
  return true;
}
