// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Refreshes the OpenRouter-sourced part of the model cards in models/cards/: each card's name and `limits`
// (context, tool calls, picture input, video lengths and shapes, voices…) from the public catalogues. The hand-written
// parts (quirks, tips, bench, sources) are never touched. No key is needed, and nothing else is fetched: QuorX never
// reads web pages into the agent's context, so tips are written by people, from the providers' docs.
//
//   node scripts/model-cards.mjs              refresh every card
//   node scripts/model-cards.mjs --add <id>   start a card for a model (its kind is found in the catalogues)
//   node scripts/model-cards.mjs --check      report cards whose model is no longer in the catalogue (exit 1)
import fs from 'node:fs';
import path from 'node:path';
import { chatModels, decisionModels, imageModels, videoModels, speechModels, musicModels } from '../server/openrouter.js';
import { CARDS_DIR, cardFile } from '../server/modelcards.js';

const args = process.argv.slice(2);
const adds = args.flatMap((a, i) => (a === '--add' && args[i + 1] ? [args[i + 1]] : []));
const checkOnly = args.includes('--check');
const today = new Date().toISOString().slice(0, 10);

const [chat, decision, image, video, speech, music] = await Promise.all([chatModels(), decisionModels(), imageModels(), videoModels(), speechModels(), musicModels()].map((p) => p.catch(() => [])));
const find = (id) => {
  for (const [kind, all] of [['decision', decision], ['video', video], ['image', image], ['speech', speech], ['music', music], ['chat', chat]]) {
    const m = all.find((x) => x.id === id);
    if (m) return { kind, m };
  }
  return null;
};
const enumOf = (p) => (p?.type === 'enum' ? p.values.filter((v) => !/^(auto|match_input)$/i.test(v)) : undefined);

/** The catalogue facts a card keeps, per kind. */
export function limitsFrom(kind, m) {
  if (kind === 'chat' || kind === 'decision') return { context: m.ctx || null, max_output: m.maxOut || null, tools: !!m.tools, images_in: (m.in || []).includes('image'), reasoning: !!m.reasoning, price_per_m: m.price.map((x) => +x.toFixed(4)) };
  if (kind === 'video') return { durations: [...(m.durations || [])].sort((a, b) => a - b), resolutions: m.resolutions || [], aspects: m.aspects || [], frames: m.frames || [], audio: !!m.audio, skus: m.skus || {} };
  if (kind === 'image') return { aspects: enumOf(m.params?.aspect_ratio) || [], resolutions: enumOf(m.params?.resolution) || [], images_in: (m.in || []).includes('image'), per_image: m.perImage, price_per_m_image_tokens: +(m.price?.[1] || 0).toFixed(4) };
  if (kind === 'speech') return { voices: (m.voices || []).length, voice_examples: (m.voices || []).slice(0, 4), price_per_m_chars: +(m.price?.[0] || 0).toFixed(4) };
  if (kind === 'music') return { length: m.length, per_use: m.perUse };
  return {};
}

fs.mkdirSync(CARDS_DIR, { recursive: true });
for (const id of adds) {
  const f = path.join(CARDS_DIR, cardFile(id));
  if (fs.existsSync(f)) { console.log(`${id}: already has a card`); continue; }
  const hit = find(id);
  if (!hit) { console.log(`${id}: not in the OpenRouter catalogues`); continue; }
  fs.writeFileSync(f, `${JSON.stringify({ id, name: hit.m.name, kind: hit.kind, refreshed: today, limits: limitsFrom(hit.kind, hit.m), quirks: [], tips: [], bench: '', sources: [] }, null, 2)}\n`);
  console.log(`${id}: new ${hit.kind} card`);
}

let missing = 0, changed = 0;
for (const f of fs.readdirSync(CARDS_DIR).filter((x) => x.endsWith('.json')).sort()) {
  const file = path.join(CARDS_DIR, f);
  const card = JSON.parse(fs.readFileSync(file, 'utf8'));
  const hit = find(card.id);
  if (!hit) { missing++; console.log(`${card.id}: not in the catalogue any more (card kept)`); continue; }
  if (checkOnly) continue;
  const limits = limitsFrom(card.kind || hit.kind, hit.m);
  if (JSON.stringify(limits) === JSON.stringify(card.limits) && card.name === hit.m.name) continue;
  const next = { id: card.id, name: hit.m.name, kind: card.kind || hit.kind, refreshed: today, limits, ...Object.fromEntries(Object.entries(card).filter(([k]) => !['id', 'name', 'kind', 'refreshed', 'limits'].includes(k))) };
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  changed++;
  console.log(`${card.id}: limits refreshed`);
}
console.log(`${changed} card(s) refreshed${missing ? `, ${missing} not in the catalogue` : ''}.`);
if (checkOnly && missing) process.exit(1);
