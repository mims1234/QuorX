// Model cards (models/cards/*.json): short notes per model for the agent and the user. Each card has
//   limits   – facts from the OpenRouter catalogue (context, tools, video lengths, shapes, picture input…), refreshed
//              by scripts/model-cards.mjs;
//   quirks   – what QuorX has seen the model do (or what its catalogue entry implies);
//   tips     – prompting advice from the provider's public docs, with the pages in `sources`;
//   bench    – a summary of QuorX's own benchmark results, where there are any.
// The agent gets only the cards of the models in use (the chat model, and each paid media tool's model), each kept
// under about 250 tokens. Nothing here fetches anything: cards are files shipped with QuorX.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './openrouter.js';

export const CARDS_DIR = path.join(ROOT, 'models', 'cards');
export const CARD_CHARS = 1000; // ≈ 250 tokens
export const cardFile = (id) => `${String(id).replace(/\//g, '__').replace(/[^\w.-]/g, '_')}.json`;

let cache = null;
/** Every card, by model id. Read once; `fresh` reads the folder again. */
export function loadCards(fresh = false) {
  if (cache && !fresh) return cache;
  cache = new Map();
  let files = [];
  try { files = fs.readdirSync(CARDS_DIR).filter((f) => f.endsWith('.json')); } catch { return cache; }
  for (const f of files) {
    try { const c = JSON.parse(fs.readFileSync(path.join(CARDS_DIR, f), 'utf8')); if (c?.id) cache.set(c.id, c); } catch { /* a broken card is skipped */ }
  }
  return cache;
}
export const cardFor = (id) => loadCards().get(String(id || '')) || null;

const list = (xs) => (Array.isArray(xs) ? xs.filter(Boolean).map(String) : []);
const range = (a) => (a?.length ? (a.length > 2 && a.every((v, i) => !i || v === a[i - 1] + 1) ? `${a[0]}-${a.at(-1)}` : a.join(', ')) : '');

/** The catalogue facts as one short line. */
export function limitsLine(c) {
  const l = c?.limits || {};
  const k = c?.kind;
  const parts = [];
  if (k === 'chat' || k === 'decision') {
    if (l.context) parts.push(l.context >= 1e6 ? `${+(l.context / 1e6).toFixed(1)}M context` : `${Math.round(l.context / 1000)}k context`);
    if (l.max_output) parts.push(`${Math.round(l.max_output / 1000)}k max output`);
    if (l.tools != null) parts.push(l.tools ? 'tool calls' : 'no tool calls');
    if (l.images_in != null) parts.push(l.images_in ? 'reads images' : 'text only');
  } else if (k === 'video') {
    if (l.durations?.length) parts.push(`${range(l.durations)} s`);
    if (l.resolutions?.length) parts.push(l.resolutions.join('/'));
    if (l.aspects?.length) parts.push(`shapes ${l.aspects.join(' ')}`);
    parts.push(l.frames?.includes('first_frame') ? `starts from a picture${l.frames.includes('last_frame') ? ' (and can end on one)' : ''}` : 'text only (no start picture)');
    if (l.audio != null) parts.push(l.audio ? 'makes sound' : 'silent');
  } else if (k === 'image') {
    if (l.aspects?.length) parts.push(`shapes ${l.aspects.join(' ')}`);
    if (l.resolutions?.length) parts.push(`sizes ${l.resolutions.join('/')}`);
    if (l.images_in != null) parts.push(l.images_in ? 'can edit or follow a reference picture' : 'text to picture only');
  } else if (k === 'speech') {
    if (l.voices) parts.push(`${l.voices} voices${l.voice_examples?.length ? ` (e.g. ${l.voice_examples.join(', ')})` : ''}`);
  } else if (k === 'music' && l.length) parts.push(l.length);
  return parts.join(' · ');
}

/** The card as the agent reads it: limits, quirks and tips, cut to CARD_CHARS (benchmarks stay for the user). */
export function cardText(c, max = CARD_CHARS) {
  if (!c) return '';
  const head = `${c.id}${c.kind ? ` (${c.kind})` : ''}`;
  const lim = limitsLine(c);
  const quirks = list(c.quirks), tips = list(c.tips);
  const build = (q, t) => [`- ${head}${lim ? `: ${lim}` : ''}.`, ...q.map((x) => `  Quirk: ${x}`), ...t.map((x) => `  Tip: ${x}`)].join('\n');
  let q = quirks, t = tips, out = build(q, t);
  // Drop the last tip, then the last quirk, until it fits.
  while (out.length > max && (t.length || q.length)) { if (t.length >= q.length && t.length) t = t.slice(0, -1); else q = q.slice(0, -1); out = build(q, t); }
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

/**
 * The note for the agent's instructions: the chat model's card, then each media model's. Models without a card are
 * left out; at most `limit` cards.
 */
export function modelNotes(ids, { limit = 6 } = {}) {
  const seen = new Set();
  const cards = ids.filter((id) => id && !seen.has(id) && seen.add(id)).map(cardFor).filter(Boolean).slice(0, limit);
  if (!cards.length) return '';
  return `\n\n[Model notes: limits from the OpenRouter catalogue, quirks seen in QuorX, prompting tips from each provider's docs. Use them when you write prompts and pick settings for these models.]\n${cards.map((c) => cardText(c)).join('\n')}`;
}

/** What the page shows on hover: everything on the card but its raw limits object. */
export function uiCards() {
  return Object.fromEntries([...loadCards().values()].map((c) => [c.id, { kind: c.kind, limits: limitsLine(c), quirks: list(c.quirks), tips: list(c.tips), bench: c.bench || '', sources: list(c.sources), refreshed: c.refreshed || '' }]));
}
