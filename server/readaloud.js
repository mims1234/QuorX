// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// ---------- 🔊 read aloud with an AI voice ----------
// Under a reply, 🔊 reads it with the PC's own voices (free, in the page) or, when you pick "AI voice", with the chat's
// 🗣 Voice model. The page sends a piece of the reply at a time (a few sentences) so the sentence highlight can follow;
// each piece is one text-to-speech call on OpenRouter, priced from the model's catalogue entry (per character).
import { speechModels, synthesize } from './openrouter.js';
import { pickVoice } from './mediaopts.js';

export const READ_ALOUD_MAX = 2000; // characters per call; the page sends shorter pieces

/** What one piece costs, from the catalogue price ($ per 1M characters). */
export const readAloudCost = (spec, text) => (spec ? (String(text).length * (spec.price?.[0] || 0)) / 1e6 : 0);

/**
 * One piece of a reply read with an AI voice: { url (a data: audio URL), model, voice, cost, chars } or { error }.
 * `voice` is the one ⚙ Settings give this model (the model's first when it has no such voice).
 */
export async function readAloudPiece({ text, model, voice }, signal, deps = { speechModels, synthesize }) {
  const words = String(text || '').replace(/\s+/g, ' ').trim();
  if (!words) return { error: 'nothing to read' };
  if (words.length > READ_ALOUD_MAX) return { error: `too long for one call (${words.length} characters, at most ${READ_ALOUD_MAX})` };
  const id = String(model || '').trim();
  if (!id) return { error: 'no Voice model is chosen: pick one in the chat\'s Quorium (🗣 Voice) or ⚙ Settings → Tools & media' };
  const spec = (await deps.speechModels().catch(() => [])).find((m) => m.id === id);
  if (!spec) return { error: `${id} is not a voice model on OpenRouter` };
  const { voice: v } = pickVoice(spec, null, voice ? String(voice) : undefined);
  const r = await deps.synthesize({ model: id, input: words, voice: v }, signal);
  return { url: r.url, model: id, voice: v || null, cost: readAloudCost(spec, words), chars: words.length, ms: r.ms };
}
