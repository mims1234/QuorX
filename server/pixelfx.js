// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Pixel art effects for games: pixelfx by Patch (https://github.com/patch-gg/pixelfx), MIT License, which its README
// says covers "code and effects". Parts of it adapt Hugo Duprez's Sprite Fusion effects and Hollow Crown by
// rehan-remade, both MIT; the Patch Pixel font in its gallery is not MIT and is never taken.
//
// Every effect is code, not a picture: an ES module that draws itself pixel by pixel through a small shared core, so
// a game can play it anywhere, mirror it, recolour it and reseed it. The canvas-game skill ships the list of effects
// and files (skills/canvas-game/pixelfx/index.json, written by scripts/pixelfx-index.mjs), naming one commit. A file
// is downloaded from that commit the first time a game wants it, checked against the hash in the index, and kept in
// data/cache/pixelfx for the next game. Adding an effect writes it, every file it imports, the layer that plays them
// (skills/canvas-game/pixelfx/layer.js), the licence and a credit into the game.
//
// Only offered when the request asks for pixel effects: "a pixel art platformer" alone is a look, not a request for
// effects. The agent never reads or edits the files under js/pixelfx: the guide (pixel-fx.md) says all it needs.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { HOME } from './openrouter.js';
import { safeFetch } from './safefetch.js';

export const REPO = 'patch-gg/pixelfx';
const SKILL_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'canvas-game');
const OWN_DIR = path.join(SKILL_DIR, 'pixelfx');
export const INDEX_FILE = path.join(OWN_DIR, 'index.json');
const GUIDE_FILE = path.join(SKILL_DIR, 'pixel-fx.md');
/** The canvas-game skill's own files for pixel effects, left out of the skill's list of extra files. */
export const SKILL_FILES = ['pixelfx', 'pixel-fx.md'];
/** Where the library lives in a game, beside its index.html. */
export const BUILD_DIR = 'js/pixelfx';
export const CACHE_DIR = () => path.join(HOME, 'data', 'cache', 'pixelfx');
export const MAX_EFFECTS = 24;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const FILE_RE = /^(core|fx\/[a-z0-9-]+)\/_?[a-z0-9-]+\.js$/;
const ID_RE = /^[a-z0-9-]+\/[a-z0-9-]+$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const MAX_FILE_BYTES = 300 * 1024;
const MAX_RESULTS = 12;
const CREDIT = `Pixel effects: pixelfx by Patch, MIT License (https://github.com/${REPO}); parts adapted from Sprite Fusion's pixel art VFX by Hugo Duprez and from Hollow Crown by rehan-remade, both MIT. The licence is in ${BUILD_DIR}/license.txt.`;

/** Whether a request asks for pixel effects (not just a pixel art look). */
export const PIXELFX_ASK = /\bpixel[- ]?(art[- ])?(effects?|fx|vfx|particles?|explosions?|animations?)\b|\bpixelfx\b|\bvfx\b/i;
export const asksForPixelFx = (text) => PIXELFX_ASK.test(String(text || ''));
/** A path under a game's js/pixelfx folder: the agent never reads, writes or searches those files. */
export const isPixelFxPath = (rel) => /(^|[\\/])js[\\/]pixelfx([\\/]|$)/i.test(String(rel || ''));

// ---------- the index ----------
let cache = null;
/** The shipped index: the commit, every file with its hash and imports, every effect with the words it is found by. */
export function index() {
  if (cache) return cache;
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')); } catch { /* no index: no effects to offer */ }
  return (cache = readIndex(raw));
}
/** Use this index instead of the shipped one (tests); null goes back to the shipped one. */
export function useIndex(raw) { cache = raw ? readIndex(raw) : null; }

const words = (t) => String(t || '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const singular = (w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
/** The share of the query's words a list of words answers (a word's start counts for a little less). */
function score(asked, have) {
  if (!asked.length) return 0;
  const set = new Set(have.map(singular));
  let total = 0;
  for (const raw of asked) {
    const w = singular(raw);
    if (set.has(w)) total += 1;
    else if (w.length >= 4 && have.some((x) => x.startsWith(w))) total += 0.6;
  }
  return total / asked.length;
}

function readIndex(raw) {
  const commit = COMMIT_RE.test(String(raw.commit)) ? raw.commit : null;
  const files = new Map();
  // Checked like anything read from disk: only files of the expected shape, from that one commit.
  for (const [rel, f] of Object.entries((commit && raw.files) || {})) {
    if (!FILE_RE.test(rel) || !HASH_RE.test(String(f?.sha256)) || !(f.bytes > 0 && f.bytes <= MAX_FILE_BYTES)) continue;
    files.set(rel, { sha256: f.sha256, bytes: f.bytes, imports: (Array.isArray(f.imports) ? f.imports : []).map(String) });
  }
  const effects = [];
  for (const e of Array.isArray(raw.effects) ? raw.effects : []) {
    if (!ID_RE.test(String(e?.id)) || !closure(files, `fx/${e.id}.js`)) continue;
    const own = [...words(e.name), ...words(e.id.replace('/', ' ')), ...(e.tags || []).flatMap(words)];
    effects.push({ ...e, own, words: [...own, ...words(e.category), ...words(e.about)] });
  }
  return { commit, files, effects };
}

/** A file and everything it imports, the file first; null when an import is missing from the index. */
export function closure(files, start) {
  const out = [];
  const visit = (rel) => {
    if (out.includes(rel)) return true;
    const f = files.get(rel);
    if (!f) return false;
    out.push(rel);
    return f.imports.every(visit);
  };
  return visit(start) ? out : null;
}

/** "Frost nova · ice · 3.4s one-shot, 288x192 px · acted". */
export function label(e) {
  const timing = e.loop ? 'loop' : `${e.duration}s one-shot`;
  const size = Array.isArray(e.size) ? `, ${e.size[0]}x${e.size[1]} px` : '';
  const extra = [e.act ? 'acted' : '', e.actor ? 'drawn on a character' : ''].filter(Boolean).join(', ');
  return [e.name, e.category, `${timing}${size}`, extra].filter(Boolean).join(' · ');
}

/** The best effects for some plain words: [{ id, label }], best first. */
export function findEffects(query) {
  const asked = words(query);
  const ranked = [];
  for (const e of index().effects) {
    const rank = Math.max(score(asked, e.own), score(asked, e.words) * 0.85);
    // Among equals, the effect named for it and those of its category ("fire") come first, then the plainest name
    // ("Rain" before "Rain splash").
    const near = score(asked, words(e.name)) + score(asked, words(e.category));
    if (rank >= 0.5) ranked.push({ e, rank, near, len: words(e.name).length });
  }
  ranked.sort((a, b) => b.rank - a.rank || b.near - a.near || a.len - b.len || a.e.id.localeCompare(b.e.id));
  return ranked.slice(0, MAX_RESULTS).map(({ e }) => ({ id: e.id, label: label(e) }));
}

/** The pixel effects guide, added to the canvas-game skill when the request asks for effects. */
export function pixelGuide() {
  try { return fs.readFileSync(GUIDE_FILE, 'utf8').replace(/^---[\s\S]*?\n---\s*\n/, '').trim(); } catch { return ''; }
}

// ---------- getting the files ----------
const hashOf = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

/** GET a file from GitHub, at most maxBytes. */
async function download(url, { maxBytes, signal }) {
  const { response } = await safeFetch(url, { signal });
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxBytes) throw new Error('the file is larger than expected');
  return bytes;
}

/** Files being downloaded right now, so two games wanting one share a single request. */
const loading = new Map();
async function load(rel, { get = download, signal } = {}) {
  const { commit, files } = index();
  const want = files.get(rel);
  const file = path.join(CACHE_DIR(), commit, ...rel.split('/'));
  try {
    // What is on disk is checked again: the folder is not trusted either.
    const kept = fs.readFileSync(file);
    if (hashOf(kept) === want.sha256) return kept;
  } catch { /* not kept yet */ }
  const bytes = await get(`https://raw.githubusercontent.com/${REPO}/${commit}/src/${rel}`, { maxBytes: want.bytes + 1024, signal });
  if (hashOf(bytes) !== want.sha256) throw new Error(`${rel} from GitHub did not match the pixelfx file QuorX knows, so it was not used`);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const part = `${file}.${process.pid}.part`;
    fs.writeFileSync(part, bytes);
    fs.renameSync(part, file);
  } catch { /* not kept: it is downloaded again next time */ }
  return bytes;
}
function loadShared(rel, opts) {
  const key = `${index().commit}/${rel}`;
  if (!loading.has(key)) loading.set(key, load(rel, opts).finally(() => loading.delete(key)));
  return loading.get(key);
}

const cleanFolder = (folder) => String(folder || '').replaceAll('\\', '/').replace(/^\.?\/+|\/+$/g, '');

/**
 * What adding these effects writes into a game, given what the game already has (has(rel) → boolean, rel from the
 * project root). Returns { files: [{ path, text }], added: [{ id, path, detail }], problems: [string] }. An effect's
 * own file is always written; a shared file the game already has is left as it is.
 */
export async function prepareEffects(ids, { folder = '', has = () => false, readText = () => '', get, signal } = {}) {
  const { commit, files, effects } = index();
  const base = [cleanFolder(folder), BUILD_DIR].filter(Boolean).join('/');
  const out = new Map(), added = [], problems = [];
  if (!commit) return { files: [], added, problems: ['no pixel effects are available in this copy of QuorX'] };
  const wanted = [...new Set((Array.isArray(ids) ? ids : [ids]).map((x) => String(x || '').trim().replace(/^pixelfx:/i, '').replace(/\.js$/i, '').toLowerCase()).filter(Boolean))];
  const already = (id) => has(`${base}/fx/${id}.js`);
  let count = countEffects(has, base, effects);
  for (const id of wanted) {
    const e = effects.find((x) => x.id === id);
    if (!e) { problems.push(`${id}: not an effect id from pixel_fx find`); continue; }
    if (!already(id) && count >= MAX_EFFECTS) { problems.push(`${id}: the game already has ${MAX_EFFECTS} effects, the most one game gets`); continue; }
    const needed = closure(files, `fx/${e.id}.js`);
    const now = needed.filter((rel, i) => i === 0 || (!has(`${base}/${rel}`) && !out.has(`${base}/${rel}`)));
    try {
      const bytes = await Promise.all(now.map((rel) => loadShared(rel, { get, signal })));
      now.forEach((rel, i) => out.set(`${base}/${rel}`, bytes[i].toString('utf8')));
    } catch (err) {
      if (signal?.aborted) throw err;
      problems.push(`${id}: ${err.message}`);
      continue;
    }
    if (!already(id)) count++;
    added.push({ id, path: `${base}/fx/${id}.js`, detail: [e.name, e.loop ? 'loops' : `${e.duration}s, then ends`, e.act ? 'acted' : '', e.actor ? 'drawn on the stock character' : ''].filter(Boolean).join(', ') });
  }
  if (added.length) {
    for (const name of ['layer.js', 'license.txt']) if (!has(`${base}/${name}`)) out.set(`${base}/${name}`, fs.readFileSync(path.join(OWN_DIR, name), 'utf8').replace(/\r\n/g, '\n'));
    const credits = [cleanFolder(folder), 'credits.txt'].filter(Boolean).join('/');
    const was = has(credits) ? readText(credits) : '';
    if (!/pixelfx by Patch/.test(was)) out.set(credits, `${was}${was && !was.endsWith('\n') ? '\n' : ''}${CREDIT}\n`);
  }
  return { files: [...out].map(([p, text]) => ({ path: p, text })), added, problems };
}

function countEffects(has, base, effects) {
  return effects.reduce((n, e) => n + (has(`${base}/fx/${e.id}.js`) ? 1 : 0), 0);
}

/** The pixel_fx tool's result after adding. */
export function addedNote({ added, problems, files }) {
  const lines = [];
  if (added.length) {
    lines.push(`Added ${added.length} effect${added.length === 1 ? '' : 's'} (${files.length} file${files.length === 1 ? '' : 's'} written):`);
    for (const a of added) lines.push(`- ${a.path} (${a.detail})`);
    lines.push(`Import each with import * as name from './${BUILD_DIR}/fx/<category>/<name>.js' (the path relative to the module that imports it) and play it with createFxLayer from ${BUILD_DIR}/layer.js, as the pixel effects part of the canvas-game skill says. Never read, copy or edit the files under ${BUILD_DIR}/. pixelfx is credited in credits.txt: show it on the game's own credits screen.`);
  }
  if (problems.length) lines.push(`Not added: ${problems.join('; ')}.`);
  return lines.join('\n') || 'Nothing to add: give the ids pixel_fx find returned.';
}

export const PIXEL_FX_TOOL = { type: 'function', function: { name: 'pixel_fx',
  description: `Ready-made animated pixel art effects for a game (pixelfx, ${index().effects.length || 244} of them): explosions, fire, spells, slashes, hit sparks, projectiles, pickups, level ups, weather, critters and screen wipes. find with plain words ("explosion, sword slash, coin, rain") lists matching effects with their timing and size; add saves the chosen ones into the game under js/pixelfx with the layer that plays them. Load the canvas-game skill first: it says how to play them.`,
  parameters: { type: 'object', required: ['action'], properties: {
    action: { type: 'string', enum: ['find', 'add'] },
    query: { type: 'string', description: 'find: plain words, several things at once separated by commas' },
    ids: { type: 'array', items: { type: 'string' }, description: `add: effect ids from find (category/name), at most ${MAX_EFFECTS} in a game` },
    folder: { type: 'string', description: 'add: the folder holding the game\'s index.html, relative to the project (default: the project folder)' },
  } } } };

/** The pixel_fx tool's result for find: one line per part of the query. */
export function findNote(query) {
  const parts = String(query || '').split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean).slice(0, 8);
  if (!parts.length) return 'Error: give find some words, such as "explosion, coin, rain".';
  return parts.map((q) => {
    const hits = findEffects(q).slice(0, parts.length > 1 ? 5 : MAX_RESULTS);
    return `"${q}": ${hits.length ? `\n${hits.map((h) => `- ${h.id}: ${h.label}`).join('\n')}` : 'no effect matches; try other words'}`;
  }).join('\n');
}
